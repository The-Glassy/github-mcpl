# Changelog

Notable changes to `github-mcpl`, loosely following
[Keep a Changelog](https://keepachangelog.com/). Entries land with the change
that causes them, as fragment files in [`changelog.d/`](changelog.d/) that are
folded into a version section at release time.

## Unreleased

## 0.1.0 — 2026-10-15

### Added

- `docs/e2e-report.md`: round 3, the webhook path against real GitHub over a
  tunnel. Issue, comment, edit, delete, PR open, push, CI, review, review
  thread reply and redelivery all arrived by webhook; `github:actor=maintainer`
  seen live; the REST API cannot request a review from an App's bot.

- `scripts/e2e/fake-host.mjs`: a scripted MCPL host for driving the built
  server against a real repository. It is `test/harness.ts`'s host moved onto
  child stdio — it spawns `dist/src/index.js --stdio`, grants every capability
  the manifest declares, answers `channels/register`, `channels/incoming` and
  `push/event` as a conforming host does, records every inbound request, and
  takes one JSON command per line so a scenario is a file and its transcript
  is the evidence. It judges results rather than whether the RPC was answered:
  a tool result carrying `isError`, an undelivered publish and a rollback
  receipt with leftovers are all failures, `expectError: true` marks a command
  whose refusal is the point, and any failure sets the exit status. It carries
  no credentials — the environment is passed to the child untouched and no
  environment value is ever read or logged. A shutdown counts as successful
  only when the child exits 0 or dies of the signal the host sent; a server
  that crashes while idle, crashes during its own shutdown, or has to be
  killed fails the run.
- `scripts/e2e/host-lifecycle-check.mjs`: the one automated check on that
  host's own lifecycle handling, which `npm test` does not reach. Seven cases
  over stub servers it writes to a temp directory — healthy, crashing while
  idle, exiting nonzero from its SIGTERM handler, ignoring SIGTERM until
  killed — asserting the host's exit status and the verdict on its
  `child-exit` line. No credentials and no network.
- `docs/e2e-report.md`: the first end-to-end run against a real GitHub App
  installation — the nine scenarios with event tags, metadata, ids, comment
  URLs and measured latencies, the deviations, and the open items a production
  installation still needs (the webhook ingress above all, which no run here
  could exercise).

- `GitHubAdapter`, the package's one GitHub client: App JWT auth from
  `GITHUB_APP_ID` and the private key file, the installation id taken from
  `GITHUB_APP_INSTALLATION_ID` or discovered for the `GITHUB_REPOS` entry, and
  an installation token cached and re-minted a minute before it expires.
- Every `GitHubApi` method over REST, with GraphQL where GitHub has no REST:
  review threads and their `isResolved` flag, `resolveReviewThread` /
  `unresolveReviewThread`, and the draft flag of a pull request (REST cannot
  change it).
- Rate limits are honoured rather than hidden: `x-ratelimit-remaining` is read
  off every answer and warned about when the hour's budget runs low, and a
  secondary-rate-limit answer buys exactly one retry after the `Retry-After`
  it names — a reset more than a minute out is reported instead of slept
  through. A rejected installation token is re-minted once and the call
  retried.
- Failures surface as `GitHubApiError` carrying the HTTP status and GitHub's
  own message, and nothing else: no token, no request URL, no header.
- The polling fallback reads up to 300 rows per `…Since` call
  (three pages of 100) and fills the head sha of at most 20 open pull requests
  per poll; when a poll hits that cap it says so on stderr and the cursor
  picks the rest up on the next tick.

- **Hosts and operators:** GitHub ingress. Webhook deliveries and a repository
  polling fallback now become normalized events.
  - A `node:http` webhook listener on `GITHUB_WEBHOOK_PORT` and
    `GITHUB_WEBHOOK_PATH` (default `/github/webhook`). It verifies
    `X-Hub-Signature-256` against `GITHUB_WEBHOOK_SECRET_FILE` in constant
    time **before** the body is parsed, caps a delivery at 1 MiB, answers
    `ping`, dedups `X-GitHub-Delivery` against a ring of the last 2000 ids,
    drops a repository outside `GITHUB_REPOS` with one stderr line, and
    answers 2xx before the event is handed on.
  - `issues`, `issue_comment`, `pull_request`, `pull_request_review`,
    `pull_request_review_comment`, `check_suite`, `check_run` and `push` are
    mapped, with the failed job names and URLs read from the check runs on the
    head sha. An event or action the contract names no kind for is dropped
    rather than guessed at. A submitted review carries the commit it was
    written against (`review.commit_id`), not the pull request's current head.
  - **One `checks.completed` per head sha.** A commit can report its checks
    many times over — two workflows are two `check_suite.completed`
    deliveries, a deployment subscribed to `check_run` gets one per job, a
    poll pass sees whatever the API says at that moment, and the webhook and
    the poller can be doing all of that at once. Both ingress paths therefore
    share one lifecycle for a head sha:
    - A head **enters** when a pull-request row or a check webhook names it.
    - It **leaves** when its checks have *settled* (every run on the sha has
      finished) **and** the listener has accepted the event. A sha with a
      suite still running is held back rather than reported with a
      provisional conclusion, so the one event it gets names every failed job
      on the commit and not just the suite that happened to finish first.
    - **Every emission for one head sha is serialized** through a per-sha
      queue, whichever path it came from. A webhook delivery and a poll pass
      for the same commit do not race: the second one waits, then reads what
      the first got accepted.
    - A mark — the worst conclusion and the set of failed jobs — is
      **committed only after the listener accepted the event**. An emission
      the committed mark already covers is dropped; a stronger conclusion, or
      a failed job the listener has not heard about, supersedes it. A refused
      or thrown delivery commits nothing and leaves no trace, so the retry or
      the other path still gets to deliver it.
    The committed marks are a ring of the last 2000 head shas. Hosts that
    were counting on one event per delivery will see fewer events, and will
    see a check event slightly later — after the last suite on the commit
    finishes rather than after the first.
  - A polling fallback on `GITHUB_POLL_INTERVAL_MS` (0 = off) asks each
    allow-listed repository what changed since its cursor — issues and pull
    requests, issue comments, review comments — and reads the check state of
    at most 20 open pull-request heads per pass. The interval never drops
    below 60 s, a server-sent `X-Poll-Interval` can only raise it, and a
    poll key is recorded (and the cursor advanced) only after the event was
    delivered, so a refused event is retried on the next pass.
  - **Unfinished check work outlives the cursor.** The poller keeps a bounded
    backlog (200 heads) of pull-request heads waiting on their check runs,
    independent of the issue cursor: a head whose lookup failed, that the
    20-lookup cap cut off, whose runs have not finished, or whose event the
    listener refused is asked about again on a later pass, round-robin so a
    long backlog does not starve its tail. A head is only retired once its
    event has been accepted, so a refusal is recoverable even after the
    cursor has moved past the pull-request row that queued the head. A head
    that reports nothing for ten passes is given up on.

- `tagsFor(event, ctx)` classifies every normalized GitHub event into RFC-001
  core tags plus the `github:` namespace, and derives the wake metadata a host
  matches `metadataTrue` rules against. `chat:ambient` is never emitted beside
  `chat:mention` or `chat:reply`, and `chat:from-self` is set for exactly one
  login — `GITHUB_BOT_LOGIN`. An App mention counts in both spellings,
  `@name` and `@name[bot]`.
- `GITHUB_TAG_ONTOLOGY` declares the emitted vocabulary for the feature-set
  declaration: every `github:` tag described, no `implies` edge into the
  reserved `chat:*` namespace, and no suggested treatment that promotes
  unaddressed traffic.
- `src/content.ts` renders events and tool results as bounded text blocks:
  bodies to 4000 chars, diff hunks to 40 lines, lists to 50 entries, titles to
  80 chars, each overflow named rather than silent. Markdown and HTML comments
  (sticky markers) pass through verbatim; no raw webhook payload field reaches
  a block.
- `docs/events.md` tabulates every GitHub event, the `NormalizedEvent` kind it
  becomes, the tags and metadata it produces, and the rendering bounds — the
  reference a recipe author writes wake policies from.
- Review-thread results carry both identifiers — the GraphQL node id
  `resolve_thread` / `unresolve_thread` take and the `rt:<root comment id>`
  reply id `reply_in_thread` takes — so an agent reading the result can act on
  it either way.

- Channels: one MCPL channel per issue and pull request
  (`github:<owner>/<name>#<number>`, type `github`, bidirectional, label
  `"<owner>/<name>#<number>: <title>"` with the title bounded to 80 chars,
  address `{ owner, name, number, kind }`).
  - Registration is lazy: a channel is announced with `channels/register` on
    the first event on a thread or the first tool touch of one, never by
    enumerating the repository. A descriptor the host refuses is not recorded,
    so a later touch asks again.
  - `channels/changed` carries the updated descriptor when the title is edited
    (or arrives after a title-less tool touch) and when the thread closes or
    reopens. The registry reports the descriptor the host *acknowledged*, so an
    update the host refuses — or one that never reaches it — leaves both sides
    agreeing and is retried on the channel's next touch.
  - Touches of one channel are serialized, so a registration still waiting on
    the host cannot swallow the title or the open/closed transition of the
    event queued behind it.
  - `channels/incoming` carries the event's rendered content, the tags and
    metadata of the tag pass, `author`/`sender` (`isBot` included), the event
    id as `messageId` and `receivedAt` as the timestamp. Thread ids follow the
    contract: a review comment is `rt:<root review comment id>`, a review
    summary `review:<review id>`, a top-level comment carries none.
  - `channels/publish` posts a comment (no thread id, or a `review:<id>`
    summary) or replies in a review conversation (`rt:<id>`), and reports the
    created comment's id and `html_url` for rollback bookkeeping. An unknown
    channel is refused with `-32023`; an attachment, an unparseable thread id
    and a review reply addressed to an issue with `-32602`.
  - `channels/typing` is a no-op that answers success: GitHub has no typing
    surface on an issue or a pull request.

- Feature-set declarations for all six sets (`github.events`, `github.read`,
  `github.comments`, `github.review`, `github.issues`, `github.pr`) with the
  capability paths each one actually uses, rollback declared only for
  `github.comments`, and the `github:` tag ontology on `github.events`.
- Read tools (`github.read`): `get_issue`, `get_pull_request`, `list_comments`,
  `list_review_threads`, `list_pull_request_files`, `get_check_runs`,
  `search_issues`. Every tool takes an optional `repo` and defaults to the
  single repository `GITHUB_REPOS` allows.
- Issue and pull-request tools (`github.issues`, `github.pr`): `create_issue`,
  `edit_issue`, `close_issue` (with a reason and an optional comment posted
  first), `reopen_issue`, `create_pull_request`, `edit_pull_request`,
  `request_review`. A pull request may only target or be retargeted to a branch
  in `GITHUB_PR_BASE_ALLOW`, refused by name otherwise; there is no merge tool.
- Review tools (`github.review`): `create_review` with inline comments on diff
  lines, `resolve_thread`, `unresolve_thread`. An `APPROVE` or
  `REQUEST_CHANGES` on the bot's own pull request is refused. `resolve_thread`
  and `unresolve_thread` take the pull request the thread is on and act only on
  a thread `list_review_threads` reports for it, so a thread id from another
  repository cannot be resolved through the allowed one.
- Every tool refuses a repository outside `GITHUB_REPOS` by name and reports a
  GitHub failure with its status and message. Everything a tool result carries
  is bounded — bodies, lists, labels, logins, refs, shas, paths, URLs and every
  echoed argument — so no field can make a result arbitrarily long.

- `github.comments`: `comment`, `reply_in_thread`, `edit_own_comment`,
  `delete_own_comment` and `upsert_sticky_comment`. The sticky upsert edits the
  bot's own comment carrying the HTML marker and keeps the marker in the body,
  creating one only when there is none; editing or deleting a comment the bot
  did not write is refused, as is any repository outside `GITHUB_REPOS`.
  `edit_own_comment` and `delete_own_comment` take an optional `review` to name
  the endpoint that owns the id (`true` a review-conversation comment, `false`
  a top-level one), since GitHub numbers the two separately and one number can
  name one of each on the same pull request. Omitted, an id that exists on both
  is refused by name rather than guessed at — a thread's `kind` cannot decide
  it, because a pull request carries comments of both kinds.
- Durable state at `GITHUB_STATE_FILE`: checkpoint lineage, the comments
  created, the previous bodies of the comments edited and the comments deleted
  per checkpoint, the poll cursor and the poll dedup ring. Written atomically
  (temp file plus rename), so a crash mid-write never replaces the state.
- `state/rollback` for `github.comments` deletes what was created after the
  checkpoint and restores the previous body of what was edited, best effort,
  with a receipt listing what could not be undone. The guarantees it reports
  under:
  - **The allow-list binds the undo.** A record naming a repository outside the
    current `GITHUB_REPOS` — a stale state file, or a changed configuration —
    is reported as not undone, by name, and no API call is made for it.
  - **One restore per comment, to the body the checkpoint named.** Several
    edits of one comment collapse into a single update to the oldest previous
    body in the range; the bodies in between are never written back, and a
    failure retains only that one target, so no retry can resurrect a version
    the checkpoint never named.
  - **An unresolved action stays booked.** Whatever could not be undone (a
    failed call, a refused repository, a comment deleted along the way) is
    recorded again under the checkpoint, so a retry attempts it once more and
    can never report a completed rollback over a state that was not restored.
    A deleted comment is booked permanently: GitHub cannot restore it, so that
    checkpoint never reports a full success again.
  - **Only a live checkpoint is rollable.** A checkpoint an earlier rollback
    left behind on an abandoned branch answers `-32005` rather than an empty
    success, since its undo records are spent and this server keeps no redo
    records. An unknown checkpoint answers `-32005` too; the `data.reason`
    tells the two apart.
  - **A comment is its repository, its id and its kind.** Issue comments and
    review comments are numbered by different endpoints, so one id can name
    both; each is undone through its own path.

- **Operators:** the install surface — `app-manifest.json` (a GitHub App
  manifest with the five permissions the tools need and no OAuth user
  flow), a README that goes from an empty account to a running server
  through GitHub's three-step manifest flow (post the manifest, catch the
  registration code with `deploy/capture-manifest-code.mjs`, exchange it
  for the App id, the key and the webhook secret straight into two
  mode-600 files created empty and filled in place), `docs/deploy.md`
  (dedicated service user, the shared environment file,
  `deploy/github-mcpl.service` with an `EnvironmentFile`, the stdio
  wrapper and its sudo rule, reverse proxy / Cloudflare tunnel /
  polling-only ingress with what polling cannot see, smee for a laptop
  test, log hygiene), two host recipes in `examples/` with wake policies
  sized for GitHub's event volume, and `docs/rayforce-house-rules.md` for
  the target repository's practices.

- **One server.** `src/server.ts` (`GitHubMcplServer`) joins the seven
  packages into a single connection, and `src/index.ts` starts it: the MCPL
  handshake with the six feature-set declarations and a `ManifestTracker`,
  `featureSets/update` through the capability grant (absence is denial — every
  tool, every channel method and every push is refused until the host grants
  the path, and the Request form's answer is the §6.7 degradation receipt),
  `tools/list` and `tools/call` routed to the five tool modules (an unknown
  tool name is refused *by name*, before the grant is consulted: a typo is not
  a policy question), `channels/list`, `channels/open`, `channels/close`,
  `channels/publish` and `channels/typing` over the channel registry,
  `state/checkpoint` and `state/rollback` over the comment store (an unknown or
  abandoned checkpoint is `-32005`), and a checkpoint after every
  `github.comments` call reported as `state: { checkpoint, parent }`. A host
  that does not advertise `experimental.mcpl` is in plain-MCP mode: tools, and
  nothing else — no push, no channels, no rollback, and every MCPL method
  answers `-32601`.
- **One event pipeline.** The webhook listener and the poller share one
  `onEvent` and one `CheckGate`, so a delivery and a poll pass cannot both
  report the same head: ingress → `tagsFor` (with `merged` and
  `reviewRequestedForSelf` read out of the raw payload, the only place either
  is stated) → `renderEvent` → `channels/incoming` for an event with a thread
  and `push/event` for every event. `isOwnThread` and `isReplyToSelf` come from
  a bounded, per-thread, per-connection lookup — the issue comments for "has
  the bot spoken here", the review threads for *which* review comments are the
  bot's, because `inReplyTo` only ever names one of those and GitHub numbers
  the two endpoints separately. A write of the bot's own updates the memory
  without a second call.
- **`src/index.ts`.** `--stdio` and `--tcp <port>`, `readConfig` (names every
  offending variable, never a value), the GitHub adapter, the checkpoint store
  from `GITHUB_STATE_FILE`, whichever ingress paths the configuration asks for,
  and a shutdown that stops the poller, closes the listener and flushes the
  state in that order. Stdout is JSON-RPC; every diagnostic is stderr.
- **Seams reconciled.** `StateStore` in `types.ts` is one type again, widened
  with `recordDeletedComment` and `checkpointStatus` so `ToolContext.state`
  needs no cast. One thread parser (`parseThread` in the new
  `src/tool-support.ts`) accepts every form both tool families took —
  `owner/name#12`, `github:owner/name#12`, `#12`, `12`,
  `{ owner, name, number, kind }`. `ToolRefusal`, `ToolArgumentError`,
  `runTool` and the argument helpers moved out of `tools-read.ts` into
  `tool-support.ts`. The two renderer families stay apart on purpose:
  `content.ts` for events and channel deliveries, the tool modules' own
  renderers for tool results, because those bound each field and `content.ts`
  bounds bodies, titles and list length — one family cannot do both without
  dropping bounds. A publish with no `threadId` is a top-level comment, never
  the latest thread on the channel. `FakeGitHubApi.updateComment` and
  `deleteComment` pick the store from the `review` flag.
- **The review round (eight findings).** `github.events` now declares
  `uses: ['pushEvents']` alone: naming the four channel paths made §6.4's
  fail-closed derivation disable the whole set for a push-only host, which the
  Contract names explicitly, so the channel surfaces are checked at their own
  call sites instead (`channels.incoming` to deliver, `channels.register` to
  announce, `channels.publish` to write, `channels.lifecycle` to open and
  close) and a channels-only grant keeps its deliveries. The channel path is
  bound by GITHUB_REPOS at `channels/open` and again before every channel
  write, refused by name before any GitHub call. Opening a channel this server
  has not announced requires `channels.register`; reading an existing
  descriptor back does not, and the registry asks before every outbound
  `channels/register` and `channels/changed`, so no announcement exercises an
  ungranted path. A checkpoint is flushed before it is acknowledged — a tool
  call's and an explicit `state/checkpoint` alike — and a persistence failure
  is an error rather than a durable-looking success. `channels/publish` is
  answered in its Notification form too (§14.3), through the same grant,
  boundary, routing and bookkeeping, with refusals logged because there is no
  id to answer. `tools/list` under MCPL offers only what the grant allows, and
  the whole surface in plain MCP. `isOwnThread` is seeded from a bounded author
  lookup (`getIssue`/`getPullRequest`) and from the state file's own write
  records, and updated the moment an authoring tool succeeds rather than when
  the bot's own webhook returns. A successful tool call registers the channel of
  the thread it touched, with the title the call resolved, read off the
  `GitHubApi` seam the tool used and never parsed out of rendered result text;
  plain MCP registers nothing. The fake host in `test/harness.ts` now refuses
  every inbound call on an ungranted capability and records it, so an
  ungranted outbound call fails a test instead of passing unnoticed.
- **The second review round (two findings).** A reduction the host
  acknowledged stops an event already in flight: the connection, the feature
  set's selection and the egress capability are evaluated immediately before
  every outbound send rather than captured at the top of the pipeline, and the
  channel registry asks again after the registration or refresh a delivery
  waits behind — so a `featureSets/update` answered while a thread lookup or a
  `channels/register` round trip is open cannot be followed by a
  `channels/incoming` or a `push/event` on a path the host just withdrew. And
  a review reply written by a tool is booked in the per-thread knowledge by
  id, as a channel publish already was, so a human answering it reads as
  `chat:reply` before the bot's own webhook arrives; issue-comment ids stay
  out of that set, because `inReplyTo` only ever names a review comment and
  GitHub numbers the two endpoints separately.
- **The third review round (three findings, one root).** The per-thread
  knowledge is one record per `<repo>#<number>` with its rules written at the
  top of the knowledge section of `src/server.ts`, because the three findings
  were its three writers disagreeing. Every writer now merges into the live
  record and never installs a snapshot over it, so a bounded history read that
  completes after a tool write keeps the `own` and the review-comment id the
  write learned. A thread's `issue | pull` kind is authoritative only from a
  webhook or from the API: a tool touch that proved nothing about it (`#58`
  means `issue` by default, and 58 may be a pull request) resolves it through
  one bounded `getPullRequest` *before* the channel is registered under it, and
  an event that contradicts a registered channel reconciles the registry's
  routing thread and its acknowledged descriptor through `channels/changed` —
  so a review reply on such a channel publishes instead of being refused for
  the rest of the connection. And "loaded" is now distinct from "something is
  known": a record a tool write created has not read the thread's history, so
  the next event still reads it, and `create_review` with inline comments
  marks it unread again, because GitHub answers that call with the review's id
  and never the comments'. A submitted review's id is never booked as a
  review-comment id.

### Changed

- The documented install runs as the agent's own user, with no `sudo`: the
  checkout in `~/github-mcpl`, the key, the webhook secret, the environment
  file and the state in `~/.config/github-mcpl` (mode 700, files 600). The
  separate `github-mcpl` system user, `/etc/github-mcpl`, `/opt/github-mcpl`
  and the sudoers rule are gone. On a host where the agent has passwordless
  `sudo` they never kept the key from it; `docs/deploy.md` ("Who can read the
  key") says what bounds a leaked key and when isolation is real.
- `deploy/github-mcpl` is now a launcher run straight from the checkout: it
  loads `~/.config/github-mcpl/github-mcpl.env` and starts the checkout's
  `dist/src/index.js` with the Node named by `GITHUB_MCPL_NODE`, so a host
  started by systemd finds an nvm Node. Both example recipes spawn it with
  `--stdio` and no `env` block; the systemd unit runs it with `--tcp`.

- **Hosts and operators:** under the polling ingress, an opened issue now
  arrives as `issue.opened` with the tag `github:issue=opened`, where before it
  could only ever be `issue.edited` (contract amendment 2a). A `since` query
  carries no action, but it does carry `created_at`, and a row created at or
  after the cursor the pass queried with is a row this poller is seeing for the
  first time. A recipe keyed on `github:issue=opened` now fires without the
  webhook ingress.
  Pull-request rows follow the same rule and gain one of their own: an open
  pull request whose head sha has not moved since the last pass is no longer
  re-announced, because the comment and review-comment rows of that same pass
  already carry what changed. One such row used to arrive on every pass that
  anything on the pull request was touched. A pull request seen for the first
  time, with no head recorded for it, still arrives once as `pull.synchronize`
  rather than not at all, so a lost state file does not leave a deployment
  blind to what is already open.
  `StateSnapshot` gains `pollHeads`; the field is additive, so a state file
  written before this loads unchanged, with no heads known.
- `isReplyToSelf` is now true for a **top-level** issue or pull-request
  comment that immediately follows one of the bot's own comments on that
  thread (contract amendment 2b, turn order). GitHub's issues endpoint models
  no reply relation at all, so before this the flag could only ever be true
  inside a review thread and every human answer to a comment the bot had made
  on an issue reached the host as plain `chat:ambient` — the bot never saw a
  follow-up on its own words. A review comment keeps the exact
  `in_reply_to_id` rule.

  The thread's bounded history read supplies the comment order, and so does
  every writer that learns of a comment without a re-read: a
  `channels/publish`, the comment tools, and the bot's own comment arriving
  back through either ingress. A comment that is **removed** — by a webhook,
  a rollback or `delete_own_comment` — leaves the order, and its id is
  remembered as gone so that no later sighting re-seats it: not a
  `listComments` begun before the deletion and landing after it, and not a
  list GitHub itself has not caught up with. Without that, a deleted comment
  of the bot's drew a reply flag out of every human comment that followed it
  for the life of the connection. The bot having *written* on a thread still
  counts whatever it later undid (`isOwnThread` is history, not a census of
  the page).

  **Not in v1:** a second rule, by which a body quoting a line of the bot's
  latest comment with `> ` also counted, is withdrawn (Amendment 2 revision,
  2026-10-14). It required the server to track which *version* of a comment's
  body was current, and five review rounds each found another interleaving —
  an edit, a rollback, an overtaken history read, a deletion webhook, a
  delayed creation echo — in which it matched text GitHub no longer held. It
  returns in a follow-up with provenance-aware body versioning. A human who
  quotes the bot without immediately following it therefore reads as
  `isReplyToSelf: false`; `chat:reply` is unaffected, since the contract
  already fires it for any thread the bot has commented in.

### Fixed

- Under polling, the bot no longer re-wakes itself on issues it took part in.
  A comment bumps its issue's `updated_at`, and the poller used to re-announce
  the issue beside the comment as `issue.edited` (or `issue.closed`) from the
  issue's author, carrying the old mention in its body. An issue row is now
  delivered only when its state, title or body changed since the last pass
  (deviation D1 is gone), a closed pull request is announced once, and a
  polled close is attributed to `closed_by`, so the bot's own close is
  from-self.
- `chat:mention` and `mentioned` count only on events that bring their text:
  `issue.opened`, `issue.edited`, `pull.opened`, `comment.created`,
  `comment.edited`, `review.submitted`, `review_comment.created`,
  `review_comment.edited`. A close, reopen, push or new commits re-carry a
  body the bot already saw; a thread the bot took part in still wakes it
  through `chat:reply`.

- A polling install no longer fails at startup on an empty webhook secret
  file. `readConfig` reads `GITHUB_WEBHOOK_SECRET_FILE` only when
  `GITHUB_WEBHOOK_PORT` is set, as the environment table always said; the
  env example names the file, so every polling install following it stopped
  with "webhook-secret is empty". Found by the Linux install rehearsal.

- `readConfig` strips trailing whitespace from the webhook secret and the App
  private key. `jq -r`, `echo` and a paste followed by Enter all end the file
  in a newline, and the README's manifest flow writes the secret with `jq -r`,
  so every documented install would have signed with a key one byte longer
  than GitHub's and refused every delivery.

- The GitHub adapter redacts credentials out of everything it emits. GitHub's
  error text, a transport failure and octokit's own diagnostics can all quote
  back something the adapter sent, so every error message and every log line is
  scrubbed twice: of the literal installation token and App JWT in hand, then
  of anything shaped like a GitHub token, a `Bearer`/`token` header pair or a
  URL carrying userinfo. `GitHubApiError` redacts in its constructor, so there
  is no way to build one that leaks through `message`, `githubMessage` or the
  stack.
- A `baseUrl` with credentials in its userinfo is refused at construction. The
  platform fetch rejects such a URL with the password quoted in the error it
  throws, before a request goes out; the adapter authenticates through the
  `authorization` header and has no use for userinfo.
- `get_check_runs` and the `checksSummary` of a pull request no longer read a
  single page. The endpoint is paginated, so a commit with more than 100 check
  runs could report `success` while a failure sat on page two. Pages are now
  followed to a bound, `total` is GitHub's own count, and a sha whose runs did
  not all fit is reported undecided rather than green.
- A secondary rate limit that names no `Retry-After` now waits a full minute
  before its single retry, as GitHub asks, instead of one second.
- An authentication failure keeps its HTTP status. A 403 from the
  installation-token endpoint used to surface as a 500 from whatever call it
  blocked, because the error escaped through octokit's transport wrapper; the
  real status, message and operation now come through.
- octokit's own diagnostics go through the configured Logger on stderr instead
  of writing to the console directly — stdout is reserved for JSON-RPC.

- The GitHub adapter redacts every credential it has issued, not just the
  current one. A token refresh replaces the cache while requests minted under
  the old token are still in flight, and the answer to one of those is exactly
  what might quote the old token back — so a replaced token stayed readable in
  an error's message and stack for up to a minute. The last eight installation
  tokens and the last eight App JWTs are now kept redactable, in separate rings
  so that JWT churn cannot evict a token.

- Credential redaction in the GitHub adapter is now structural rather than
  statistical. Every logical call holds the credentials it actually put on the
  wire, retries included, until that call settles, so no amount of token
  rotation underneath an unresolved request can age its credential out of the
  redaction set — a bounded history of recent credentials could, and did: eight
  401-driven retries were enough to make a held request's own token readable in
  the error it eventually raised.
- Credentials are retained by validity instead of by count. An installation
  token lasts an hour and an App JWT nine minutes, and neither can be
  refreshed, so a credential is kept redactable until GitHub would refuse it
  and dropped afterwards. The set prunes itself and needs no eviction policy;
  a ceiling remains only as an anti-OOM guard and does not bind in a realistic
  run.

