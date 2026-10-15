# Deploying github-mcpl on your own host

[README.md](../README.md) takes you from an empty GitHub account to a server
you can start by hand. This file is the rest: where the process lives, who
can read the secrets, how a GitHub webhook reaches it, and what the logs may
and may not contain. Nothing here needs you to read the source.

Everything below assumes the layout README.md uses, all of it owned by the
user the agent runs as (`ubuntu` on a typical agent host):

| Path | Mode | What |
| --- | --- | --- |
| `~/github-mcpl` | as cloned | the checkout, built in place (`dist/`, `node_modules/`) |
| `~/.config/github-mcpl/` | 700 | everything the server reads or writes besides its code |
| `~/.config/github-mcpl/github-mcpl.env` | 600 | variable names and paths, **no secrets** |
| `~/.config/github-mcpl/app-private-key.pem` | **600** | the App private key |
| `~/.config/github-mcpl/webhook-secret` | **600** | the webhook secret, one line |
| `~/.config/github-mcpl/state.json` | 600 | checkpoint lineage and the poll cursor |

The server refuses to start if either secret file is readable by group or
other: `readConfig` stats both and reports the mode by name. That check is the
reason the two files are separate from the environment file.

**Coming here from a finished registration?** Then the directory and both
credential files already exist — [README.md's manifest
flow](../README.md#3-create-the-github-app-from-the-manifest) made them, at
mode 600 — and there is nothing to do in this section. Check and move on:

```sh
ls -l ~/.config/github-mcpl/
# -rw------- ubuntu ubuntu … app-private-key.pem
# -rw------- ubuntu ubuntu … webhook-secret
```

**Setting the host up by hand**, with the key and the secret from the App's
settings page instead:

```sh
install -d -m 700 ~/.config/github-mcpl
cd ~/.config/github-mcpl

# Only where it is missing. `install /dev/null` over a live key empties it,
# and an empty key file is a startup failure, not a warning.
for f in app-private-key.pem webhook-secret; do
  [ -e "$f" ] || install -m 600 /dev/null "$f"
done
```

Then fill the two files **in place** — `cat > file`, an editor opened on
them, or `ssh <host> 'cat > ~/.config/github-mcpl/app-private-key.pem' < key.pem`
from the machine the key downloaded to — so the mode `install` set is what
the content lands under. Never `cp` or `scp` a fresh file and fix the mode
afterwards: that leaves the private key readable by others in between.

## Build

`~/github-mcpl` is the checkout
[README step 1](../README.md#1-put-the-code-and-node-on-the-host) made — it
has to exist that early, because the registration in step 3 runs a script out
of it. Build it where it stands; do not clone a second copy.

```sh
cd ~/github-mcpl
git pull                    # only when you are updating an older checkout
npm ci
npm run build               # tsc into dist/
```

`npm ci` is the only command here that needs the network, and it talks to the
npm registry only. Nothing is installed outside the checkout.

## The environment file (both shapes need it)

Both shapes start the server through the launcher
[`deploy/github-mcpl`](../deploy/github-mcpl), which loads
`~/.config/github-mcpl/github-mcpl.env`, exits 1 if it cannot
(`github-mcpl: cannot read …/github-mcpl.env`), and starts
`dist/src/index.js` of the checkout it sits in with the Node that
`GITHUB_MCPL_NODE` names. [README step 7](../README.md#7-set-the-environment)
writes the file and has every variable.

The file holds the App id, the bot login, the repository, the ingress
settings and the **paths** of the two secret files — never their contents: a
value there lands in the environment of the server and of every process it
starts.

## Two shapes

An MCPL host can reach the server in one of two ways, and they want different
supervision. Pick one.

### Shape A — the host spawns it over stdio (e.g. connectome-host)

This is what [`examples/recipe-rayforce.json`](../examples/recipe-rayforce.json)
describes and what connectome-host supports today: the host spawns the
launcher as a child process, as its own user, and speaks JSON-RPC over the
pipe.

```json
"command": "/home/ubuntu/github-mcpl/deploy/github-mcpl",
"args": ["--stdio"]
```

There is no unit to enable — the host's own service supervises it, and
`reconnect: true` in the recipe restarts it if it dies. The recipe needs no
`env` block: connectome-host passes `HOME` and `PATH` to its children, and the
launcher takes everything else from the environment file.

### Shape B — a standalone daemon on TCP (systemd)

[`deploy/github-mcpl.service`](../deploy/github-mcpl.service) runs the
launcher with `--tcp 9041` as the agent's user, with nothing secret in the
unit. Use it when the host dials the server rather than spawning it, or when
you want the process (and so the webhook listener) to stay up across host
restarts. Note that connectome-host currently spawns stdio servers only, so
for connectome-host the answer is shape A. This is the one step that needs
`sudo`: replace `REPLACE_WITH_AGENT_USER` in the unit first.

```sh
sudo install -m 644 deploy/github-mcpl.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now github-mcpl
systemctl status github-mcpl
journalctl -u github-mcpl -f
```

A bad environment is a startup failure with one line per offending variable
and no secret in it, so `journalctl -u github-mcpl -n 20` tells you exactly
what to fix.

## Who can read the key

The server runs as the agent's user, so the agent can read the App private
key — the same way an agent holds its other logins. That is a
deliberate choice, not an oversight:

- **A separate service user only binds an agent without root.** On the usual
  agent host the agent's user has passwordless `sudo`, and `sudo cat`
  reads any file of any user. A second user there guards against accidents
  and costs upkeep (a sudo rule, a wrapper, logs the agent cannot see); it
  does not stop an agent that was talked into reading the key.
- **What bounds a leaked key** is the App itself: installed on one
  repository, `contents: read` (no push, no new branch), no merge tool, PR
  bases checked against `GITHUB_PR_BASE_ALLOW`. The worst case is comments,
  issues and reviews under the bot's name on that one repository. Revoke it
  by generating a new key in the App's settings and deleting the old one.
- **Two agents on one host** each get their own unix user and home. A home is
  mode 750 by default on current Ubuntu, so one agent's
  `~/.config/github-mcpl` is not readable by the other.

Isolation from the agent is real in two cases only: the agent's user has no
`sudo` without a password, or the server runs on another host (shape B over
TCP) that the agent cannot log in to.

## Getting events in

The server has two independent ingress paths, and you need exactly one.

**Run one at a time.** The two paths dedup separately and cannot recognise
each other's work: a webhook delivery is deduped by its `X-GitHub-Delivery`
id, a polled row by `poll:<kind>:<id>:<updated_at>`, and the same comment
arriving down both paths produces two different keys, so both rings let it
through. The agent then sees one comment twice and may answer it twice.
Nothing in the server prevents this — it is a configuration choice, so make
it deliberately: set `GITHUB_WEBHOOK_PORT` **or** `GITHUB_POLL_INTERVAL_MS`,
not both. (Turning polling on for an hour while the webhook path is broken is
a reasonable thing to do; just turn the webhook's **Active** box off in the
App's settings while you do, and back on after.)

### Option 1 — webhook behind a reverse proxy with TLS

The server's listener is plain HTTP on `GITHUB_WEBHOOK_PORT` and verifies
`X-Hub-Signature-256` with the secret file before it parses a byte. Terminate
TLS in front of it; GitHub will not deliver to plain HTTP.

nginx:

```nginx
location /github/webhook {
    proxy_pass http://127.0.0.1:9042;
    proxy_set_header Host $host;
    proxy_set_header X-Hub-Signature-256 $http_x_hub_signature_256;
    proxy_set_header X-GitHub-Delivery   $http_x_github_delivery;
    proxy_set_header X-GitHub-Event      $http_x_github_event;
    client_max_body_size 25m;
}
```

Caddy:

```caddy
hooks.example.com {
    reverse_proxy /github/webhook 127.0.0.1:9042
}
```

Then set the App's webhook URL (Settings → your App → Webhook) to
`https://hooks.example.com/github/webhook`, the same path as
`GITHUB_WEBHOOK_PATH`. Bind the listener to loopback only — the proxy is the
only thing that should reach it — and let nothing but the proxy's port through
the firewall. GitHub publishes its delivery source ranges at
`https://api.github.com/meta` (`hooks`) if you want to narrow that further.

### Option 2 — a tunnel, no inbound port

If the host has no public address, a Cloudflare tunnel gives you a stable
HTTPS URL without opening anything:

```sh
cloudflared tunnel login
cloudflared tunnel create github-mcpl
cloudflared tunnel route dns github-mcpl hooks.example.com
cloudflared tunnel run --url http://127.0.0.1:9042 github-mcpl
```

Run `cloudflared` under its own systemd unit, not inside the host's. The webhook
URL is then `https://hooks.example.com/github/webhook`.

### Option 3 — polling only, no webhook at all

Leave `GITHUB_WEBHOOK_PORT` unset (the listener is then off and the webhook
secret is not required) and set `GITHUB_POLL_INTERVAL_MS`:

```ini
#GITHUB_WEBHOOK_PORT=
GITHUB_POLL_INTERVAL_MS=120000
```

The poller asks the repository for issues and pull requests, issue comments
and review comments updated since its cursor, and for the check runs on the
heads of the open pull requests it saw (at most 20 per poll). The floor is
60000 ms and a smaller non-zero value is a startup error, not a silent
correction — the installation token's rate limit is shared with every tool
call the agent makes.

**Polling is a partial fallback, not an equal second path.** Those four
queries are everything it has, so what reaches the agent is everything they
contain and nothing else:

| Arrives | Does not arrive |
| --- | --- |
| an issue or pull request opened, edited, closed, reopened | `review.submitted` — an approval or a changes-requested review, and its summary body |
| a comment created or edited | `pull.review_requested` — so `isReviewRequested` is never set and the review-request wake never fires |
| an inline review comment created or edited | a deletion (a polled row that is gone is simply absent) |
| a check conclusion on an open pull request's head | `push` with no thread attached, and the distinction between `synchronize` and any other PR update |

The two in the second column that matter are the review ones: a repository
whose reviews are the work — rayforce, where the maintainer reviews inline
and requests reviews by hand — needs the webhook. **If the clone must wake on
a submitted review or a review request, polling-only is not enough.**
Everything else degrades gracefully: the thread update that carries the
review still arrives, just later, without the review's own event or tags.

Also set the App's webhook to inactive (uncheck "Active") when you deploy this
way, so GitHub stops queueing deliveries nobody collects.

### A laptop test with smee.io

For trying the thing out before you own a public name, smee forwards GitHub's
deliveries to your loopback port:

```sh
npx smee-client --url https://smee.io/<your-channel> --path /github/webhook --port 9042
```

Put the smee channel URL in the App's webhook URL field. This is a test tool:
the channel is a public URL that anyone who learns it can post to, which is
survivable only because the signature check rejects anything not signed with
your secret. Do not leave a production installation pointed at smee.

## E2E against a sandbox

Do not rehearse against the real repository. The sandbox for this work is the
private repository `theaspirational/github-mcpl-sandbox`: default branch
`dev`, and a CI workflow that fails whenever a `.fail` file exists in the
tree, which is how a `github:ci=failure` event is produced on demand. Install
the App on that repository alone, set `GITHUB_REPOS` to it, and walk the list
in TASK-SRHKG.1 (an issue arrives as a push event and a `channels/incoming`
with the documented tags; a publish lands as a comment; a review-thread reply
lands in its thread; `create_review` posts two inline comments;
`upsert_sticky_comment` edits in place on the second call; a rollback deletes
what was created after the checkpoint; the `.fail` commit arrives as
`github:ci=failure` with the job URL).

## Log hygiene

The server never logs a token, a key, a webhook secret or a signed URL; that
is a property of the code, and the `Logger` is the only way anything reaches
stderr. What it does log is enough to identify a thread: repository, issue
number, actor login, event kind, delivery id. Treat the journal as carrying
the repository's private content.

- **Stdout is the protocol.** In stdio mode anything printed on stdout
  corrupts the JSON-RPC stream and the host drops the connection. Nothing in
  the wrapper may print there, which is why `deploy/github-mcpl` sends its own
  errors to stderr and why the unit sets `StandardOutput=null`.
- **The agent can read these logs.** In shape A the server's stderr goes
  wherever the host sends its children's stderr, under the agent's user; in
  shape B `journalctl -u github-mcpl` is readable by the agent once it has
  `sudo`. Treat the log as one more copy of the repository's private content
  on that host, and keep its retention short.
- **Rotate.** `journalctl --vacuum-time=14d` (or `SystemMaxUse=` in
  `journald.conf`) — a chatty repository at 60–115 events a day fills a small
  disk slowly but surely.
- **A delivery body never reaches the log.** If you add debug printing while
  chasing a problem, remove it afterwards: an issue body is other people's
  text and often the one thing you must not persist.
- The reverse proxy logs the webhook URL on every delivery. That URL is not a
  secret (the signature is what authenticates a delivery), but the access log
  does reveal the repository's event rate; the same retention rules apply.

## When it does not work

| Symptom | Where to look |
| --- | --- |
| Startup exits at once | `deploy/github-mcpl --stdio < /dev/null` (shape A) or `journalctl -u github-mcpl -n 20` (shape B): one line per bad variable, by name |
| `… is mode 644; it holds secret material and must be 600` | `chmod 600` the named file |
| Deliveries show 401/403 in the App's "Advanced → Recent Deliveries" | the secret in the file differs from the one in the App settings |
| Deliveries show 404 | the proxy path and `GITHUB_WEBHOOK_PATH` disagree |
| Deliveries are green, the agent never wakes | the host's wake policies, not the server: see the recipes in [`examples/`](../examples/) and the host's gate status |
| Events arrive for the wrong repository | they are dropped by the allow-list, with a stderr line naming the repository |
