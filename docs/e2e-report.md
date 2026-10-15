# WP10 — end to end on the sandbox

TASK-SRHKG.1.10. This connector against real GitHub: round 1, the review that
failed it, and the eight fix rounds that closed it.

| | |
| --- | --- |
| Branch | `wp10-e2e`, cut from `main` at `a6311d7` |
| Repository | `theaspirational/github-mcpl-sandbox` (private; default branch `dev`, release branch `main`) |
| App | `git-hub-mcpl-sandbox` (public slug only), bot login `git-hub-mcpl-sandbox[bot]` |
| Ingress | **polling only**, `GITHUB_POLL_INTERVAL_MS=60000`; webhook port unset, no tunnel |
| Base allow-list | `GITHUB_PR_BASE_ALLOW=dev` |
| Maintainers | `GITHUB_MAINTAINERS` unset, so `isMaintainer` is `false` on every event below — correct for this configuration |
| Host | `scripts/e2e/fake-host.mjs`, full grant (7 capabilities), `{"accepted":true,"unavailableFeatures":[],"notes":[]}` |
| Round 1 | 2026-10-14 12:28:28Z – 12:42:53Z, two server processes over one state file, built from `a6311d7` |
| Fix round | 2026-10-14 13:23:09Z – 13:25:47Z, built from `dec22c3` (both amendments in) |

## Commits

| Sha | What |
| --- | --- |
| `1ec4270` | **Amendment 2a** — a poll row's kind from `created_at` against the cursor. With unit tests in `test/normalize.test.ts`, `test/poller.test.ts`, `test/state.test.ts` and two integration cases in `test/integration.test.ts`. |
| `02ce882` | **Amendment 2b** — `isReplyToSelf` for a top-level comment. With unit tests in `test/normalize.test.ts` (the fixture expectation table) and four integration cases in `test/integration.test.ts`. |
| `dec22c3` | The host judges results rather than whether the RPC was answered, and keeps the child's exit promise from spawn (round-1 findings 2 and 4). |
| `c9d8506` | This report, reorganised under the task's nine scenarios, with its figures recomputed (round-1 findings 1 and 5). |
| `3d64f16` | The two leftover sandbox branches deleted and logged in the ledger. |

Round 2 of the review failed it on three reproduced defects, each fixed in its
own commit with the test the reviewer specified:

| Sha | What |
| --- | --- |
| `370f5bb` | **A refused `pull.synchronize` is retried, not lost** (HIGH). The head sha was committed at collection time, so a refusal the cursor correctly held back was then dropped by the next pass as "no change". The head now commits on acceptance, with the dedup key. Two tests in `test/poller.test.ts`: the refused event is retried and delivered once, and a collection failure after a changed head advances nothing. |
| `f3822c2` | **A sticky edit updates the lines a quote is matched against** (MEDIUM). `updateComment` was never observed despite the comment saying it was, so an edited sticky comment left the old body's lines in the thread record. One integration case in `test/integration.test.ts`. |
| `140b8f5` | **An idle child crash fails the run** (MEDIUM). `scripts/e2e/fake-host.mjs` returned 0 when the server died between commands. An intentional shutdown is now distinguished from an unexpected exit. |
| `b2d8ad5` | Open item **O4** narrowed — a fresh cursor starts one interval back, so first-sighting `pull.synchronize` applies only to the rows that query returns. |

Round 3 of the review found two more, both reproduced offline:

| Sha | What |
| --- | --- |
| `56a8bf6` | **A rollback keeps the thread's reply knowledge true** (MEDIUM). The rollback runs on the unobserved context, so neither a restored body nor a deleted top-level comment reached `ThreadKnowledge`: a restored sticky comment still matched the body the rollback had discarded, and a deleted bot comment stayed in the turn order so the next unrelated human comment read as a reply to it. The rollback now reports each success internally, `deleteComment` joins the observed seam (which `delete_own_comment` needed too), and a new explicit removal path takes a comment out of the turn order — `learn` is a merge and cannot express a removal, and marking the history unloaded does not help because the re-read only inserts. Five integration cases in `test/integration.test.ts`. |
| `487f087` | **A shutdown that fails is not a successful run** (MEDIUM). A server exiting 3 from its own SIGTERM handler was reported `{code: 3, expected: true}` with exit 0, yet that status is how a server says its shutdown failed. A shutdown is clean only on exit 0 or death by the signal sent; escalation to SIGKILL never is. Checked by `scripts/e2e/host-lifecycle-check.mjs`, seven cases over stub servers. |

Round 4 of the review found two more in the removal path round 3 added, both
reproduced offline against the reviewer's probes. **Two commits, one per
finding** — the tombstone set closes the second on its own, but the first is
a routing bug in `handleEvent` that no amount of tombstoning would reach, so
they are not one change:

| Sha | What |
| --- | --- |
| `480ca69` | **A deletion event removes the comment, it does not re-seat it** (HIGH). `handleEvent` fed every delivery carrying a comment through the insert branch, so a `comment.deleted` webhook — the ordinary way a deletion is learned, and the one that arrives after a rollback GitHub has already applied — put the deleted comment straight back into the turn order and its body back into the quote hashes. A top-level deletion now routes to the removal path instead. Two integration cases, driving the real `WebhookListener` over signed loopback HTTP: the deletion-after-rollback case end to end, and a human deleting their own comment leaving the bot's turn order right. |
| `8d860e8` | **A history read cannot undo a write that outran it** (HIGH). A bounded `listComments` is asynchronous and only the decision to mark the record `loaded` consulted the invalidation generation; the facts were merged whenever they landed. A snapshot begun before a rollback-delete seated the comment again; one begun before a rollback-restore brought the discarded body back. Neither healed, because `learn` only inserts. Removals are now remembered by id in a bounded `removedComments` and refused from every later sighting; `botComment` is stamped `asOf` the generation its read answers for and dropped if the record has moved on; a restore bumps the generation. Four integration cases. |

The `asOf` gate is deliberately narrow — it drops the bot's body, not the
whole snapshot. Dropping the snapshot wholesale also discards the *other*
people's comments in it, which leaves the turn order claiming the bot spoke
last when it did not; that produced a false `isReplyToSelf` of its own, found
by the fourth test below and not by the reviewer's probe. Removals are carried
by the tombstone set instead, which is exact where the generation is merely
conservative, and which also covers the one case no generation can see: a read
started *after* a deletion against a list GitHub has not caught up with.

Each of the three mechanisms is load-bearing, checked by reverting them one at
a time:

| Reverted | Which of the four round-4 `learn` tests fail |
| --- | --- |
| all of `8d860e8` | all four |
| `removedComments` only | the rollback-delete snapshot, and the lagging list |
| the `asOf` gate only | the event tagged from the stale snapshot |
| the restore's generation bump only | the sticky-restore snapshot, and the event tagged from it |

A fourth candidate mechanism was dropped for failing exactly this test:
invalidating the thread on *every* removal rather than only on the bot's
latest. Nothing needed it — the tombstone is exact and the turn order is
already spliced — and it would have cost a full history read on every deletion
webhook, including humans deleting their own comments on threads nobody is
waiting on.

Round 5 of the review found the last of the reply-knowledge family, in the
generation gate round 4 had just added. **One commit**:

| Sha | What |
| --- | --- |
| `14e9a90` | **An edit supersedes a history response read before it** (FAIL). Round 4's `asOf` gate rejects a history response only when the record's generation has moved, and only a rollback's restore advanced it. A successful `upsert_sticky_comment` or `edit_own_comment` learned its new body without bumping, so a `listComments` captured before the edit still passed the gate — and since an edit keeps the comment's id, the latest-id guard had nothing to object to either. The stale response put the removed text back as the lines a quote is matched against and marked the record loaded, so nothing re-read it: a pending human event quoting the old body was tagged `isReplyToSelf: true`, and from then on the thread matched the removed body and not the live one. Both editing tools reproduced it. Learning the bot's body from an edit now advances the generation, exactly as learning it from a restore does. Three integration cases. |

The gate stays as narrow as round 4 left it, and the third test is what holds
it there. It covers `botComment` alone, so a superseded response still
contributes the other participants' turns it saw; discarding those would leave
the turn order claiming the bot spoke last when a human had, which is a
different wrong answer rather than a fix. `own` is not gated at all, so
historical ownership survives.

| Test | Fails without the bump | Fails if the gate is widened |
| --- | --- | --- |
| the sticky edit during a held read | yes | yes |
| the `edit_own_comment` during a held read | yes | yes |
| the superseded response still contributing a turn | no — it is the guard, not the reproduction | yes |

The third case judges the event *holding* the stale response rather than a
later one, because the fix's own invalidation makes the next event re-read the
thread and repair the order behind the assertion's back; only the held event is
tagged from the merge itself.

Round 6 of the review found that body observations were never ordered among
themselves. **One commit**:

| Sha | What |
| --- | --- |
| `9d3ac02` | **The bot's body is ordered by GitHub's clock, not by arrival** (FAIL). Equal ids refreshed the quote hashes unconditionally, so the *last* observation of a comment won whoever it came from — and two arrive out of order from GitHub's side: a creation webhook echoing the original body after a later edit has already succeeded, and a `listComments` begun after the edit but answered by a replica that had not caught up. Both then stood, because `learn` only inserts. A human quoting the body GitHub no longer held read as a reply to self; one quoting the live body did not. The record now keeps `botLatestCommentUpdatedAt` beside the lines and applies a body only when GitHub's own stamp for it is later than the stored one. Eight integration cases. |

Rounds 4 and 5 ordered observations by a local generation counter, which can
only order what this server set in motion — neither of these is. `updated_at`
is the one clock the webhook comment object, the list response and the edit
response all share, which is why the manager chose it.

It is an ordering, not a ratchet. A genuinely later edit still updates the
lines, a higher comment id still wins outright (another comment's clock says
nothing about this one), and an equal stamp with a different body — the most
GitHub's one-second resolution leaves ambiguous — goes to the tool response,
which is the write that produced the newer body rather than a reading of the
older one. An unstamped observation is still applied and clears the stored
stamp with it, which is the previous last-writer-wins behaviour kept for
anything that cannot be ordered.

Each branch of the rule carries tests of its own:

| Reverted | Failing |
| --- | --- |
| the clock rule entirely | the four echo and lagging-read cases |
| the later-stamp branch (a ratchet) | those four **and** the two later-edit cases |
| the same-second tie-break | the two tie cases |

One thing the change had to fix that the finding did not name:
`forgetComment` clears the stamp along with the lines it belongs to. Without
that, deleting the bot's latest comment left the dead comment's *newer* stamp
dating the survivor's body, which then refused the very re-read meant to
recover it. Round 3's partial-rollback case caught it.

Round 7 did not find a sixth fix. It recorded the manager's decision that the
quote rule leaves v1:

| Sha | What |
| --- | --- |
| `4362f8d` | **Amendment 2b is the turn-order rule only in v1.** Round 7 reproduced a sixth interleaving — an equal-`updated_at` disagreement with no local write to break the tie — and confirmed it is unreachable with turn order alone. The quote rule and everything that existed only to serve it is removed: the line hashing, `botLatestCommentLines`, `botLatestCommentId`, the `updated_at` body ordering and its tie-break, `learn`'s `botComment` input and `asOf` gate, the body-invalidation generation bumps, the lines-promotion half of `forgetComment`, and the `EDITED_COMMENT` observer. Turn order, removals, tombstones, `own` and `botReviewIds` are untouched. 555 → 540 tests. |

The five rounds of fixes above were each correct and each left another
interleaving, which is the evidence the decision rests on: the rule needs
body versioning with provenance, and that is a feature rather than a patch.
Nothing in the recorded scenarios changes — scenario 3's live
`isReplyToSelf: true` was the turn-order rule, and it still holds.

Round 8 found that round 7 cut one thing too many:

| Sha | What |
| --- | --- |
| `2c892c4` | **A successful edit still teaches the comment's identity** (FAIL, a round-7 regression). Dropping the `EDITED_COMMENT` observer also dropped the comment's *identity* — `comments: [{ id, mine: true }]`. Round 7 justified that by saying the bounded history read would cover it "because a tool touch leaves the record unloaded"; true of a record a tool touch creates, false of one already loaded, and a loaded record is never read again. So where the history read had missed the bot's comment, editing it taught nothing and the human comment right after read as `chat:ambient` on a thread ordered human, bot, human. The observation is back, identity only — the id GitHub answered with, no body. Review-comment edits stay excluded. 540 → 543 tests. |

That regression is the one place the withdrawal cost something it should not
have. The quote rule is still out; what came back is the turn-order fact an
edit had always carried alongside it.

Both amendments are recorded in `docs/contract-notes.md`. Nothing else under
`src/` changed.

**Measurement.** An ingress latency is **action time → host delivery**: the
action time is GitHub's own timestamp for the row (the tail of the
`poll:<kind>:<id>:<updated_at>` event id), and the delivery time is when this
host recorded the `push/event`. A tool latency is request → response. Every
figure below was recomputed from the transcripts for this round; see
**Corrections** for the two that round 1 got wrong.

## The nine scenarios

| # | Scenario | Verdict | Latency | Round |
| --- | --- | --- | --- | --- |
| 1 | A human opens an issue | **pass** | 54.7 s | fix round |
| 2 | A human comment mentioning the bot | **pass** | 6.2 s | round 1, re-confirmed 38.0 s |
| 3 | `publish` without `threadId`, then the human reply after it | **pass** | 0.7 s / 42.0 s | fix round |
| 4 | A review thread: `create_review` with two inline comments, and the reply into it | **pass** | 1.7 s / 64.7 s | round 1 |
| 5 | `upsert_sticky_comment` twice | **pass** | 1.3 s + 1.4 s | round 1 |
| 6 | `state/checkpoint`, two comments, an edit, `state/rollback` | **pass** | 2.7 s | round 1 |
| 7 | A workflow that fails, then passes | **pass** | 68.2 s / 48.7 s | round 1 |
| 8 | Polling delivers 1 to 3 within the poll interval | **pass** | 54.7 / 38.0 / 42.0 s | fix round |
| 9 | A base outside the allow-list refused; `dev` accepted | **pass** | 0.00 s / 1.6 s | round 1 |

Scenarios 1, 2, 3 and 8 were re-run against the sandbox on the fixed build,
because 1 and 3 are the two the amendments changed. Scenarios 4 to 7 and 9 keep
their round-1 evidence: no amendment touches the review-comment rule, the
sticky path, the rollback path, the checks path or the base allow-list, and
re-running them would have been four more pull requests on the sandbox for an
unchanged result.

---

### 1. A human opens an issue → `github:issue=opened`

**Did:** `gh issue create` as the owner (a human). Issue
[#4](https://github.com/theaspirational/github-mcpl-sandbox/issues/4),
`created_at` and `updated_at` both `2026-10-14T13:23:18Z` (`gh api`, so no edit
had happened).

**Arrived** at `13:24:12.672Z` — **54.7 s**, one poll interval — on both egress
paths, with the channel registered lazily first
(`github:theaspirational/github-mcpl-sandbox#4`, label
`theaspirational/github-mcpl-sandbox#4: e2e round 2: amendment 2a and 2b
against the sandbox`).

```json
{
  "eventId": "poll:issue:5848609849:2026-10-14T13:23:18Z",
  "tags": ["chat:from-human", "chat:ambient", "github:issue=opened"],
  "origin": {
    "source": "github",
    "repo": "theaspirational/github-mcpl-sandbox",
    "kind": "issue.opened",
    "number": 4,
    "threadKind": "issue",
    "channelId": "github:theaspirational/github-mcpl-sandbox#4",
    "actor": "theaspirational",
    "htmlUrl": "https://github.com/theaspirational/github-mcpl-sandbox/issues/4"
  },
  "metadata": {
    "repo": "theaspirational/github-mcpl-sandbox", "number": 4, "kind": "issue",
    "actor": "theaspirational",
    "htmlUrl": "https://github.com/theaspirational/github-mcpl-sandbox/issues/4",
    "mentioned": false, "isOwnThread": false, "isReplyToSelf": false,
    "isCiFailure": false, "isMaintainer": false, "fromSelf": false
  }
}
```

`github:issue=opened`, and `chat:edited` is gone with it. **In round 1 this was
the one failing scenario**: the row arrived as `github:issue=edited` with
`chat:edited`, and the host's 180 s wait on `=opened` is still in the round-1
transcript as a timeout. Amendment 2a (`1ec4270`) fixed it. Every metadata field
the contract names is present.

### 2. A human comment mentioning the bot → `chat:mention`

**Did:** `gh issue comment` as the owner, body containing
`@git-hub-mcpl-sandbox`.

**Round 1** — comment
[6168418281](https://github.com/theaspirational/github-mcpl-sandbox/issues/1#issuecomment-6168418281),
created `12:32:29Z`, delivered `12:32:35.211Z` — **6.2 s**. Tags
`["chat:from-human","chat:mention","chat:reply"]`, `mentioned: true`.

**Fix round** — comment
[6169407846](https://github.com/theaspirational/github-mcpl-sandbox/issues/4#issuecomment-6169407846),
created `13:24:36Z`, delivered `13:25:14.001Z` — **38.0 s**.

```json
{
  "eventId": "poll:issue_comment:6169407846:2026-10-14T13:24:36Z",
  "tags": ["chat:from-human", "chat:mention", "chat:reply"],
  "origin": { "kind": "comment.created", "number": 4, "threadKind": "issue",
    "channelId": "github:theaspirational/github-mcpl-sandbox#4",
    "actor": "theaspirational",
    "htmlUrl": "https://github.com/theaspirational/github-mcpl-sandbox/issues/4#issuecomment-6169407846" },
  "metadata": { "mentioned": true, "isOwnThread": true, "isReplyToSelf": false,
    "fromSelf": false, "isMaintainer": false }
}
```

`isReplyToSelf` is correctly **false** here: this comment follows the *human*
comment of scenario 3, not the bot's. That is amendment 2b discriminating, not
blanket-setting — the same pass produced one comment with the flag and one
without.

### 3. `publish` without `threadId`, then the human reply → `chat:reply` and `isReplyToSelf`

**Did:** `channels/publish` with no `threadId` (the connector), then
`gh issue comment` as the owner immediately after it, with nothing in between.

**The publish** answered in **0.7 s** with comment
[6169404442](https://github.com/theaspirational/github-mcpl-sandbox/issues/4#issuecomment-6169404442):

```json
{ "delivered": true, "messageId": "6169404442", "commentId": 6169404442,
  "route": "comment", "isReviewComment": false,
  "htmlUrl": "https://github.com/theaspirational/github-mcpl-sandbox/issues/4#issuecomment-6169404442",
  "thread": { "repo": { "owner": "theaspirational", "name": "github-mcpl-sandbox" }, "number": 4, "kind": "issue" } }
```

Verified independently with `gh api .../issues/4/comments`: author
`git-hub-mcpl-sandbox[bot]`.

**The human reply** — comment
[6169406803](https://github.com/theaspirational/github-mcpl-sandbox/issues/4#issuecomment-6169406803),
created `13:24:32Z`, delivered `13:25:13.999Z` — **42.0 s**:

```json
{
  "eventId": "poll:issue_comment:6169406803:2026-10-14T13:24:32Z",
  "tags": ["chat:from-human", "chat:reply"],
  "origin": { "kind": "comment.created", "number": 4, "threadKind": "issue",
    "channelId": "github:theaspirational/github-mcpl-sandbox#4",
    "actor": "theaspirational",
    "htmlUrl": "https://github.com/theaspirational/github-mcpl-sandbox/issues/4#issuecomment-6169406803" },
  "metadata": { "mentioned": false, "isOwnThread": true, "isReplyToSelf": true,
    "fromSelf": false, "isMaintainer": false }
}
```

**`isReplyToSelf: true` on a top-level issue comment.** **In round 1 this was
impossible**: GitHub's issues endpoint carries no `in_reply_to_id` at all, so
the flag could only ever be true inside a review thread, and every answer to
the bot on an issue reached the host as plain `chat:ambient`. Round 1 reported
that as "by design, not reachable"; the review decided otherwise, and amendment
2b (`02ce882`) derives it — here from the turn-order rule, the bot's comment
being the one immediately before this one.

In the same pass the bot's own comment came back as
`["chat:from-self","chat:reply"]` with `fromSelf: true`, so the self-mute path
is exercised on live data too.

### 4. A review thread: `create_review` with two inline comments, and a reply into it

**Did:** `gh pr create` as the owner (PR
[#3](https://github.com/theaspirational/github-mcpl-sandbox/pull/3), a
*human-opened* PR, which is the realistic maintainer case and a different code
path from a bot-opened one); then `create_review` (the connector); then
`gh api .../pulls/3/comments/4270802936/replies` as the owner; then both
`channels/publish` with the thread id and `reply_in_thread`.

**`create_review`** answered in **1.7 s**: review
[5517937471](https://github.com/theaspirational/github-mcpl-sandbox/pull/3#pullrequestreview-5517937471)
with two inline comments. `gh api .../pulls/3/comments` confirms both are
thread roots on the Files tab at the lines asked for:

| Comment | Path | Line | Side | `in_reply_to_id` |
| --- | --- | --- | --- | --- |
| [4270802936](https://github.com/theaspirational/github-mcpl-sandbox/pull/3#discussion_r4270802936) | `review_target.py` | 5 | `RIGHT` | `null` |
| [4270802949](https://github.com/theaspirational/github-mcpl-sandbox/pull/3#discussion_r4270802949) | `review_target.py` | 9 | `RIGHT` | `null` |

**The human reply** — comment
[4270806912](https://github.com/theaspirational/github-mcpl-sandbox/pull/3#discussion_r4270806912),
created `12:34:41Z`, delivered `12:35:45.684Z` — **64.7 s**:

```json
{
  "eventId": "poll:review_comment:4270806912:2026-10-14T12:34:41Z",
  "tags": ["chat:from-human", "chat:reply", "chat:thread", "github:review-comment"],
  "origin": { "kind": "review_comment.created", "number": 3, "threadKind": "pull",
    "channelId": "github:theaspirational/github-mcpl-sandbox#3",
    "actor": "theaspirational",
    "htmlUrl": "https://github.com/theaspirational/github-mcpl-sandbox/pull/3#discussion_r4270806912" },
  "metadata": { "isOwnThread": true, "isReplyToSelf": true, "mentioned": false,
    "fromSelf": false, "isMaintainer": false }
}
```

and on the channel, the thread identity the contract specifies:

```json
{ "channelId": "github:theaspirational/github-mcpl-sandbox#3",
  "threadId": "rt:4270802936",
  "messageId": "poll:review_comment:4270806912:2026-10-14T12:34:41Z" }
```

`rt:<root review comment id>`. This is the *exact* rule (`inReplyTo ∈
botReviewIds`), which amendment 2b deliberately left alone.

**Writing back into that conversation** — both routes landed in it, and `gh`
confirms both carry `in_reply_to_id: 4270802936`:

| Route | Result | Comment |
| --- | --- | --- |
| `channels/publish` with `threadId: "rt:4270802936"` | `route: "review-reply"`, `isReviewComment: true`, 1.1 s | [4270821304](https://github.com/theaspirational/github-mcpl-sandbox/pull/3#discussion_r4270821304) |
| `reply_in_thread` | `replied in rt:4270802936 … (comment 4270821542)`, 1.0 s | [4270821542](https://github.com/theaspirational/github-mcpl-sandbox/pull/3#discussion_r4270821542) |

The **second** root thread (4270802949) was left untouched by both, so the
routing is by thread id and not "the latest thread".

### 5. `upsert_sticky_comment` twice → one comment, edited

**Did:** `upsert_sticky_comment` twice with marker `wp10-status` on PR
[#2](https://github.com/theaspirational/github-mcpl-sandbox/pull/2) (the
connector).

```
1.3 s  created sticky <!-- wp10-status --> on theaspirational/github-mcpl-sandbox#2 (comment 6168488882)
1.4 s  updated sticky <!-- wp10-status --> on theaspirational/github-mcpl-sandbox#2 (comment 6168488882)
```

The same id — created, then updated. `gh api .../issues/2/comments` returned
**exactly one** comment,
[6168488882](https://github.com/theaspirational/github-mcpl-sandbox/pull/2#issuecomment-6168488882),
`created_at 12:36:27Z`, `updated_at 12:36:28Z`, the marker retained at the top
of the second body. One comment, edited in place.

### 6. `state/checkpoint`, two comments, an edit, `state/rollback`

**Did:** `state/checkpoint`; `comment` twice; `edit_own_comment` of the sticky
comment from scenario 5, which **pre-dates** the checkpoint; then
`state/rollback` (all the connector).

Checkpoint **`chk_17283636`**. Written: comments
[6168498040](https://github.com/theaspirational/github-mcpl-sandbox/pull/2#issuecomment-6168498040)
and
[6168498267](https://github.com/theaspirational/github-mcpl-sandbox/pull/2#issuecomment-6168498267),
plus the edit of 6168488882. The receipt, in **2.7 s**:

```json
{ "checkpoint": "chk_17283636", "success": true, "notUndone": [],
  "undone": [
    { "action": "delete",  "repo": "theaspirational/github-mcpl-sandbox", "commentId": 6168498267, "review": false, "thread": { "number": 2, "kind": "pull" } },
    { "action": "delete",  "repo": "theaspirational/github-mcpl-sandbox", "commentId": 6168498040, "review": false, "thread": { "number": 2, "kind": "pull" } },
    { "action": "restore", "repo": "theaspirational/github-mcpl-sandbox", "commentId": 6168488882, "review": false, "thread": { "number": 2, "kind": "pull" } }
  ] }
```

Deletes in reverse order of writing, `notUndone` empty. On GitHub afterwards:
both comment ids return **HTTP 404**, and 6168488882 holds its pre-checkpoint
body byte for byte — a rollback restores an *edit*, not only its own creations.

### 7. A workflow that fails → `github:ci=failure` with the failed job URL

**Did:** `git push` a commit adding `.fail` to the PR #2 branch, then a commit
removing it. CI (`ci.yml`, job `check`) fails whenever `.fail` is present.

**Failure** — head `68c4176`, pushed `12:37:45Z`, delivered `12:38:53.159Z` —
**68.2 s**:

```json
{
  "eventId": "poll:checks:68c4176cf17370b0c0333e23b451568e488033dd:failure:2:38ed1d0da74f",
  "tags": ["chat:from-bot", "chat:reply", "github:ci=failure"],
  "origin": { "kind": "checks.completed", "number": 2, "threadKind": "pull",
    "channelId": "github:theaspirational/github-mcpl-sandbox#2", "actor": "github",
    "htmlUrl": "https://github.com/theaspirational/github-mcpl-sandbox/pull/2" },
  "metadata": { "isCiFailure": true, "isOwnThread": true, "isMaintainer": false }
}
```

with the failed jobs named and linked in the content the host receives:

```
checks: failure, 2 failed
- check — https://github.com/theaspirational/github-mcpl-sandbox/actions/runs/38565274522/job/115856243720
- check — https://github.com/theaspirational/github-mcpl-sandbox/actions/runs/38565268207/job/115856221127
```

Two failed jobs because the workflow runs `on: [push, pull_request]`, so the
same commit fails twice — both are reported, each with its own job URL.

**Recovery** — head `f7a3d39`, pushed `12:39:07Z`, delivered `12:39:55.690Z` —
**48.7 s**, `github:ci=success`, `isCiFailure: false`, delivered fresh and not
from the host's backlog. One `checks.completed` per head sha held across both.

### 8. Polling delivers scenarios 1 to 3 within the poll interval

The fix round's three ingress events, all on `GITHUB_POLL_INTERVAL_MS=60000`,
measured action → host delivery:

| Scenario | Action | Delivered | Latency |
| --- | --- | --- | --- |
| 1, the issue | `13:23:18Z` | `13:24:12.672Z` | **54.7 s** |
| 3, the human reply | `13:24:32Z` | `13:25:13.999Z` | **42.0 s** |
| 2, the mention | `13:24:36Z` | `13:25:14.001Z` | **38.0 s** |

All inside one interval. Two poll passes carried them, and the server's own
accounting agrees — `{"since":"2026-10-14T13:23:09.665Z","delivered":1,...}`
then `{"since":"2026-10-14T13:24:09.665Z","delivered":4,...}`, zero duplicates
and zero failures in both. The upper bound is the interval plus the pass's own
work; nothing here approached it.

### 9. A base outside the allow-list is refused; `dev` opens

**Did:** `create_pull_request` twice (the connector), from the pushed branch
`wp10-e2e-pr`.

| Base | Result | Latency |
| --- | --- | --- |
| `main` | `create_pull_request refused: base branch "main" is not in GITHUB_PR_BASE_ALLOW (allowed: dev)`, `isError: true` | **0.00 s** |
| `dev` | PR [#2](https://github.com/theaspirational/github-mcpl-sandbox/pull/2) opened, head `ce144c9` → `dev` | 1.6 s |

The refusal took **0.00 s** — decided locally, before any request reached
GitHub. Under the fixed host this scenario is now written with
`"expectError": true`, so the refusal is the pass and a base that slipped
*through* the allow-list would fail the run; round 1's host would have called
either outcome a pass (review finding 2).

---

## Extras

Beyond the nine, from round 1.

**`edit_pull_request` retargeting.** To `main`: refused, same message, **0.00
s**. To `dev`: accepted in 1.3 s, PR #2 returned with base `dev`. The
allow-list is checked on edit exactly as on creation.

**Restart over one state file.** On `SIGTERM` the first process flushed
`lastPollAt: 2026-10-14T12:39:53.162Z`, `current: chk_6ffc00e0`, 9 checkpoints
and 22 dedup keys. The second process then rolled back to **`chk_40741387`** —
a checkpoint taken by the *previous* process — in 1.7 s, and comment
[6168555929](https://github.com/theaspirational/github-mcpl-sandbox/pull/2#issuecomment-6168555929),
written before the restart, is **HTTP 404**. The first pass after the restart
logged `{"since":"2026-10-14T12:39:53.162Z","delivered":1,"duplicates":1,"failed":0}`:
one genuinely new row and **one suppressed redelivery**. Comparing the 22
`eventId`s delivered before the restart with those after: **intersection 0**.

**`request_review`.** Requested `theaspirational` on PR #2 in 0.9 s;
`gh pr view 2 --json reviewRequests` confirms it. The *tag*
`github:pr=review_requested` still cannot be produced by polling (open item
**O3**).

**The amendment 2a state migration, unplanned.** The round-1 state file was
written before `pollHeads` existed. The fixed build loaded it, kept its cursor
and all 27 dedup keys, logged nothing, and flushed it back with
`pollHeads: {}`. The additive-field claim is therefore tested on a real
pre-amendment file and not only in `test/state.test.ts`.

## Corrections to round 1

| Round 1 said | Actually | Why |
| --- | --- | --- |
| Mention latency **4 s** | **6.2 s** | Round 1 read the timestamp of a *different* message in the same poll pass. That pass delivered three `channels/incoming` requests; the first (the bot's own comment) landed at `12:32:33.600Z` and the mention's at `12:32:35.211Z`. Against the comment's `created_at` of `12:32:29Z`, and by the report's own action → delivery definition, the mention took 6.2 s. |
| PR #2's row delivered **4 times** | **6 times** (4 before the restart, 2 after) | Round 1 counted only the first transcript. The six: `12:33:37Z`, `12:36:28Z`, `12:37:46Z`, `12:39:08Z` (first process), `12:41:02Z`, `12:41:50Z` (second). This makes deviation **D1** worse than round 1 stated, which is the reason amendment 2a addresses it. |
| Scenario 1 **partial**, `github:issue=opened` "not reachable under polling" | **pass** | Decided as amendment 2a, not a limitation. See scenario 1. |
| Scenario 3's `isReplyToSelf` "by design, not reachable" on an issue | **pass** | Decided as amendment 2b. See scenario 3. |

Round 1 also judged every answered RPC a pass, so its scenario 9 and its
retarget row recorded refusals as successes for the right reason by accident.
The host now judges the result (finding 2); the verdicts above were re-derived
under it, and the fix round's five commands all passed with the host exiting 0.

## Deviations from the contract

**D1 — under polling, one human action can still produce two events, for an
issue.** *Resolved after the Linux rehearsal (2026-10-15): an issue row is now
delivered only when its state, title or body changed since the last pass, so
a comment's bump no longer re-announces the issue. The text below is the
original finding.* A comment bumps its issue's `updated_at`, so the issue row is
re-collected and delivered beside the comment event as `github:issue=edited`.
The fix round shows the shape: three comments in one pass produced three
comment events and **one** extra issue row (`poll:issue:5848609849:…13:24:36Z`),
because the dedup key carries `updated_at` and the three comments share one.
So the cost is one extra row *per pass in which the thread changed*, not one
per comment.

Amendment 2a removed this for **pull requests** — an open PR row whose head did
not move is now dropped, since the comment rows of the same pass already carry
the change — which is what round 1's six deliveries of PR #2's row were. It
deliberately did **not** remove it for issues: an issue row has no head sha to
compare, and an `issue.edited` with no comment beside it is the only way a
title or body edit arrives at all. A host that does not want the extra row can
mute `github:issue=edited`; the recipe's default treatment already throttles
`chat:ambient` at one per two minutes.

Nothing else deviated. The parts that are easy to get wrong on live data all
held: `rt:<root id>` thread identity, review-reply routing to the right one of
two threads, sticky edit-in-place, rollback ordering and the restore of an
edit, one `checks.completed` per head sha, the base allow-list on both create
and edit, and the dedup ring surviving a restart.

## Open items for the maintainer's installation

- **O1 — closed by round 3 below** (webhook over a tunnel, 2026-10-14 21:17Z–21:31Z). As it stood after round 2: the webhook path is entirely unexercised against real GitHub. No
  tunnel was available, so `GITHUB_WEBHOOK_SECRET` and the webhook port were
  unset and `src/webhook.ts` never ran in either round. Its signature
  verification, its action map and the `CheckGate` it shares with the poller
  have unit coverage only. **The largest untested surface remaining**, and it
  grew in importance with amendment 2a: the webhook path reports the action
  outright, so it needs none of 2a's inference, and the two paths now derive
  the same kinds by visibly different routes.
- **O2 — closed by round 3 below** (`github:actor=maintainer` on every human event with `GITHUB_MAINTAINERS=theaspirational`). As it stood: the maintainers tag was never produced. `GITHUB_MAINTAINERS` was
  unset, so `isMaintainer` was `false` on all 32 `push/event`s across both
  rounds and `github:actor=maintainer` never appeared. The path
  (`src/tags.ts:215-216`) is a list membership test with unit coverage; the
  real install needs the variable populated and one event checked.
- **O3 — closed by round 3 below as not producible for an App identity**: the REST API silently drops a GitHub App's bot from `requested_reviewers`, and the web UI's Reviewers picker does not list the App at all (checked by the owner on PR #9). A human asks for a review with a mention. As it stood: `github:pr=review_requested` was never produced. `request_review`
  works against real GitHub (above), but the *tag* comes from a webhook action
  and polling cannot emit it, so `isReviewRequested` was `false` throughout.
  A recipe keyed on it needs O1.
- **O4 — amendment 2a's first-sighting behaviour, and how small it actually
  is.** An open pull request older than the cursor, seen by a poller with no
  recorded head for it, arrives once as `pull.synchronize` (the alternative was
  leaving a cold start blind to work already in flight).

  The scope is narrower than it first looks, and round 1 of this report
  overstated it. A poller with no stored cursor does not ask about all of
  history: `since` defaults to one interval before the pass
  (`src/poller.ts:319`), so `listIssuesSince` returns only the rows **touched
  in that last interval**. So the first pass after a fresh or lost state file
  announces one `synchronize` per pull request *that was updated in the last
  poll interval* — not one per open pull request. On a quiet repository that is
  usually none at all.

  Still worth knowing, because it is the one behaviour of 2a a deployment can
  meet on its first pass, and it was not exercised against real GitHub — the
  sandbox had no pre-existing open pull request at either start.
- **O7 — a deleted *review* comment's id stays in `botReviewIds`.** The
  removal path is top-level only, by instruction across rounds 3 and 4, so a
  review comment deleted by a rollback or by `delete_own_comment` leaves its id
  in the record and a later comment naming it as `in_reply_to` would still read
  as a reply to self. Judged not a blocker on review: GitHub removes a review
  thread along with its root, so there is nothing left for a reply to target,
  and `botReviewIds` is deliberately unchanged. It is the one corner of the
  removal family these rounds did not close.
- **O9 — the quote rule is withdrawn from v1 and owed to v1.x.** Amendment 2b
  shipped with a second rule beside turn order: a body quoting a line of the
  bot's latest comment. It is removed (Amendment 2 revision, 2026-10-14) after
  five review rounds each found another interleaving in which it matched text
  GitHub no longer held. What it needs is provenance-aware body versioning —
  every observation of a body carrying where it came from and how it is
  ordered against the others — which is a feature, not a patch. Until then a
  human quoting the bot *after somebody else's turn* reaches the host with
  `isReplyToSelf: false`. `chat:reply` is unaffected, because the contract
  already fires it for any thread the bot has commented in, so only a recipe
  matching `isReplyToSelf` itself sees the difference. The behaviour is pinned
  by a test, so reinstating it has to be a decision.
- **O5 — single repository, single installation.** `GITHUB_REPOS` held exactly
  one repository and the App exactly one installation. Multi-repo allow-lists
  and token refresh across several installations are unexercised; no run lasted
  long enough to refresh the ~1 h installation token. *(Token refresh: covered
  by the soak below. Several repositories: accepted by the configuration since
  the multi-repo change, one owner per process, covered by unit tests and not
  yet by a live run.)*
- **O6 — scale.** The busiest poll pass handled 6 candidates and delivered 4.
  Pagination bounds, the 50-entry list cap and rate-limit behaviour were never
  approached.

## Every GitHub write these runs made

All on `theaspirational/github-mcpl-sandbox`; nothing was written anywhere else.

| By | Write |
| --- | --- |
| `gh` (human), round 1 | issue **#1** opened; one comment mentioning the bot (**6168418281**); branches `wp10-e2e-pr` and `wp10-e2e-review` pushed (3 commits, incl. adding and removing `.fail`); PR **#3** opened; one review-thread reply (**4270806912**); a closing comment on #2 and on #3; PRs #2 and #3 closed |
| connector, round 1 | PR **#2** opened (`create_pull_request`); review **5517937471** with 2 inline comments (`create_review`); **4270821542** (`reply_in_thread`); sticky **6168488882** created then updated (`upsert_sticky_comment`); **6168498040**, **6168498267** (`comment`, both since rolled back); one edit of 6168488882 (`edit_own_comment`, since reverted); **6168555929** (`comment`, since rolled back); base retargeted to `dev` (`edit_pull_request`); review requested from `theaspirational` (`request_review`); issue #1 closed with a comment (`close_issue`) |
| `channels/publish`, round 1 | **6168412289** (top-level comment on #1); **4270821304** (review reply in `rt:4270802936`) |
| `gh` (human), fix round | issue **#4** opened; one reply comment (**6169406803**); one mention comment (**6169407846**) |
| connector, fix round | **6169404442** (`channels/publish`, top-level); issue #4 closed with a comment (`close_issue`, **6169431029**) |
| deletions, comments | **6168498040**, **6168498267**, **6168555929** — all by `state/rollback`, all confirmed 404 |
| deletions, branches | `wp10-e2e-pr` (at `f7a3d39`) and `wp10-e2e-review` (at `68972e3f`), by `gh api -X DELETE`, after both their pull requests were closed |

Left behind: issues #1 and #4 closed, and PRs #2 and #3 closed unmerged each
with a comment saying it was an e2e run. The two branches those pull requests
were opened from were deleted once the pull requests were closed — no scenario
needed them, and the closed pull requests keep their own record of the commits.
`gh api repos/…/branches` now returns `dev` and `main` only. Nothing was merged
into either. The repository is still private.

## Secrets

The App id, the private key and the installation id were never printed, copied
or written into any committed file, and they are not in this report or in
`scripts/e2e/fake-host.mjs`. The host reads no environment value: it passes
`process.env` to the child untouched and logs only frames and the child's exit
status. The App is named here by its public slug. Scanned for the installation
id, the App id, PEM markers and the key and env-file paths; the only match in
either file is the *name* `GITHUB_WEBHOOK_SECRET`, in a sentence saying it was
unset.

One caution for whoever reads the raw evidence: the server logs the
installation id at `info` when it discovers an installation, so the host's
`--log` file contains it. Those logs live under `/tmp` and are **not
committed**; the two poll-pass lines quoted in scenario 8 are the only server
log output reproduced here.

The fix round used a state file under `/tmp` rather than the operator's
configured one, to keep the poll window tight and leave round 1's state intact
for the comparisons above. A state file holds cursors, checkpoint ids and
comment ids — no credential.

## Reproducing this

```sh
npm ci && npm run build
set -a; . "$GITHUB_MCPL_ENV"; set +a       # never echo this file
mkfifo /tmp/cmd && sleep 100000 > /tmp/cmd &
node scripts/e2e/fake-host.mjs --log /tmp/host.log < /tmp/cmd > /tmp/transcript.jsonl &
# then, per scenario, append one JSON command per line to /tmp/cmd
echo '{"cmd":"call","name":"get_issue","args":{"number":4}}' >> /tmp/cmd
echo '{"cmd":"call","expectError":true,"name":"create_pull_request","args":{"head":"x","base":"main","title":"t"}}' >> /tmp/cmd
```

The host exits non-zero if any command failed, so a scenario file cannot pass
by being read without being checked. The command vocabulary is the doc comment
at the top of `scripts/e2e/fake-host.mjs`.

Rounds 3 to 8 made **no sandbox run and no GitHub write**, by instruction:
their findings were reproduced offline against the reviewer's probes and are
covered by `npm test` and `node scripts/e2e/host-lifecycle-check.mjs`, neither
of which reads a credential or touches the network. Nothing from the
reviewers' evidence directories was copied into the tree.

## Gates

Run through `orgasmic dispatch gate` in the `repos/github-mcpl` checkout, at
the final sha on a clean tree:

| Gate | Command | Result |
| --- | --- | --- |
| `typecheck` | `npm run typecheck` | exit 0 |
| `test` | `npm test` | exit 0 — **543 pass, 0 fail** (555 before round 7, which removed the quote rule's cases from rounds 2 to 6 and added one pinning the withdrawal; round 8 added three) |
| `host-lifecycle` | `node scripts/e2e/host-lifecycle-check.mjs` | exit 0 — **7/7 cases** |
| `build` | `npm run build` | exit 0 |

The receipts are recorded `other-checkout`, because the code is a nested git
repository inside the dispatch worktree rather than the worktree itself; a
reviewer should treat them as logs to read, not as reusable receipts, and
re-run the three commands if that distinction matters.

---

# Round 3 — the webhook over a tunnel

2026-10-14 21:17Z – 21:31Z, from `main` at `20ee782`. Same sandbox, same App,
same host script; the ingress is the one thing changed.

| | |
| --- | --- |
| Ingress | **webhook only**: `GITHUB_WEBHOOK_PORT=9042`, `GITHUB_WEBHOOK_PATH=/github/webhook`, poller off |
| Tunnel | `tailscale funnel --bg 9042` on the operator's laptop; the App's webhook URL is the node's `*.ts.net` name |
| Maintainers | `GITHUB_MAINTAINERS=theaspirational` |
| Secret | a 64-hex file, mode 600, **no trailing newline** (see "Three things that bit" below) |
| Host | `scripts/e2e/fake-host.mjs` from a FIFO, one process for the whole round, state file shared with rounds 1–2 |

## Scenarios

Latency is from the human's `gh` command (or the connector's tool result) to
the `push/event` the host recorded. GitHub's own hook latency is inside it.

| # | Scenario | Verdict | Latency | What arrived |
| --- | --- | --- | --- | --- |
| W1 | A human opens an issue (#6) | **pass**, after one redelivery | 1.3 s from delivery | `issue.opened`, `github:issue=opened`, `github:actor=maintainer`, `isMaintainer: true` |
| W2 | A human comment mentioning the bot | **pass** | 2.9 s | `chat:mention`, `mentioned: true`, `github:actor=maintainer` |
| W3 | `publish` without `threadId`, then the human reply | **pass** | 4.5 s | the bot's own comment came back `chat:from-self`; the reply carried `chat:reply`, `isReplyToSelf: true` |
| W4 | The human edits, then deletes that reply | **pass** | 3.8 s / 2.1 s | `comment.edited` + `chat:edited`; `comment.deleted` + `chat:deleted`. Polling cannot see either. |
| W5 | `create_pull_request` into `dev` (#7), push `.fail`, CI fails | **pass** | 3.3 s / 3.8 s / 15.4 s | `pull.opened` (`chat:from-self`), `github:push`, `pull.synchronize`, one `checks.completed` with `github:ci=failure` out of four check deliveries |
| W6a | A human submits a review on #7 | **pass** | 4.8 s | `review.submitted`, `github:review=commented` — a kind polling never produced |
| W6b | `create_review` with an inline comment on a human PR (#8), the human replies in the thread | **pass** | 5.0 s / 1.8 s | the reply reached `channels/incoming` with `threadId: rt:4276472389`, `chat:thread`, `github:review-comment` |
| W6c | `reply_in_thread` into that thread | **pass** | 1.2 s | `route: review-reply`; the bot's own event came back `chat:from-self` |
| W7 | Request a review from the bot (`github:pr=review_requested`) | **not producible** | — | `POST …/requested_reviewers` answers 201 with `requested_reviewers: []` on a bot-opened and on a human-opened PR, and the web UI's Reviewers picker on PR #9 does not list the App; no delivery is created. A mention is how a human asks this bot for a review. |
| W8 | GitHub redelivers an already-processed delivery | **pass** | — | `webhook delivery dropped: replay of a delivery id already seen`; no second `push/event` |
| W9 | Remove `.fail` (CI passes), close #7, #8, #5, #6 | **pass** | 31 s / 1–5 s | `github:ci=success`, `pull.closed` ×2, `issue.closed` ×2 |

Totals for the round: 78 `push/event`s and 24 `channels/incoming`
recorded; 0 errors and 0 warnings from the server apart from the 10
deliberately unsigned probes it rejected with 401; 1 replay dropped.

## Three things that bit

1. **The webhook secret file had a trailing newline.** `openssl rand -hex 32 >
   file` ends in `\n`, and so does the README's `jq -r .webhook_secret` flow.
   `readConfig` passed the bytes through untouched, so every signature would
   have failed. Fixed on `main` at `20ee782` (trailing whitespace stripped from
   both secret files, asserted in `test/smoke.test.ts`). Found before the first
   delivery, so no delivery was lost to it.
2. **An App created from a manifest with `hook_attributes.active: false` sends
   nothing.** GitHub creates no delivery at all; the only trace is an empty
   deliveries log. `PATCH /app/hook/config` can set the URL and the secret but
   not `active`; that is a checkbox in the App's settings page. A manual
   redelivery of the creation-time `ping` *does* go out while inactive, which
   makes the tunnel look healthy. Worth one sentence in `docs/deploy.md`.
3. **Funnel's public ingress stalled for about five minutes.** The first two
   deliveries (21:17:17Z and a redelivery at 21:18:49Z) hit GitHub's 10 s
   timeout. Probing each ingress address separately with `curl --resolve`:
   `185.40.234.55` hung for 25 s per request between about 21:19:30Z and
   21:21:40Z while `.75` and `.198` answered in 0.3 s; from 21:22Z all three
   answered. GitHub does not retry a timed-out delivery on its own, so each
   stall is a lost event unless someone redelivers it. The 34 deliveries after
   21:22Z all got 202. For the maintainer's installation this argues for a host
   with a stable public address (deploy option 1) or Cloudflare (option 2)
   rather than Funnel from a laptop, and for the polling fallback as the safety
   net when the webhook is the only ingress.

One observation, not a defect: the bot's own `review_comment.created` in W6c
carried `isReplyToSelf: true` although the preceding comment in that thread
was the human's. Own events are tagged `chat:from-self` and a host does not
wake on them, so nothing depends on the flag there.

## Every GitHub write this round made

Issues #5 and #6 (opened, closed); comments 6178806590 (human), 6178818426
(connector), 6178820712 (human, edited, deleted); branches `wh-e2e-pr`
(commits `f9963df`, `af0a9d8`, `c181e93`), `wh-e2e-human` (`e183772`),
`wh-e2e-ui` (`f3cf39d`); PRs #7 (connector, closed), #8 (human, closed), #9
(human, closed after the UI review-request check); a human review on #7;
the connector's review on #8 with inline comment 4276472389, the human reply
4276474310 and the connector's reply; branches `wh-e2e-pr`, `wh-e2e-human` and `wh-e2e-ui`
deleted. App side: webhook URL and secret set through `PATCH /app/hook/config`,
one `ping` and three event deliveries redelivered through
`POST /app/hook/deliveries/{id}/attempts`.

Nothing was merged. `dev` and `main` are untouched.

## Soak: one installation-token lifetime

The same server process stayed up from 20:18Z to 22:26Z. The first installation
token was minted at 21:22:17Z (`expiresAt` 22:22:17Z). At 22:25:00Z, after 54
minutes with no traffic, a human comment on #6 reached `push/event` in 7.4 s
with no stall. At 22:25:56Z the first tool call after the expiry (`get_issue`)
logged a second `installation token minted` (`expiresAt` 23:25:56Z) and
answered; a `comment` write with that token followed. No warning or error in
the whole run. Rate limits were never approached: the round made on the order
of a hundred API calls against the installation's 5,000 per hour, so that part
of the checklist rests on the adapter's unit coverage of 403/429 handling, not
on this run.

# Linux install rehearsal (2026-10-15)

The README's setup, followed step by step on a Linux host other than the
operator's laptop, as the agent's own user and with no `sudo`, after the
install moved from a separate system user into the agent's home (`105cb8b`).

| | |
| --- | --- |
| Host | Ubuntu 24.04, systemd 255, user with a home at mode 750 |
| Node | v22 from nvm, not on the `PATH` of a non-interactive shell |
| Source | a git bundle of `main` (the host has no GitHub credentials); every other step as written |
| Ingress | polling, 60000 ms; webhook port unset |
| Start | `scripts/e2e/fake-host.mjs --server deploy/github-mcpl` under `env -i HOME=… PATH=/usr/bin:/bin`, the variables connectome-host passes a child |

Steps 1, 2, 3 (path B's guarded creation), 7 and 8 ran as written. The App
private key was filled over ssh into the existing mode-600 file, the way path
B now documents it.

**Two defects found, both fixed before the live part:**

1. A polling install stopped at startup with `webhook-secret is empty`:
   `readConfig` read `GITHUB_WEBHOOK_SECRET_FILE` whenever it was named, and
   the env example names it. It now reads it only with `GITHUB_WEBHOOK_PORT`
   set (`2973693`, test in `test/smoke.test.ts`).
2. README step 8 quoted a startup line the server no longer prints.

**Live, against the sandbox:**

| Step | Result |
| --- | --- |
| Human opens #10 mentioning the bot | `issue.opened` after 52 s, tags `chat:from-human`, `chat:mention`, `github:actor=maintainer` |
| `get_issue`, `comment`, `close_issue` (with a comment) | all ok; both comments by `git-hub-mcpl-sandbox[bot]`, #10 closed as completed |
| Next poll | the bot's two comments as `chat:from-self` |
| State file | written, mode 600 |
| `quit` | host and server exited, nothing left running |

One warning in the run: octokit reported that GitHub has deprecated the
default REST API version for `PATCH /repos/{owner}/{repo}/issues/{n}`, with
removal scheduled for 2028-03-10. Nothing fails today.

**One wake-policy problem under polling, fixed the same day.** The `issue.closed`
row of that poll carried `chat:mention` and `chat:from-human` with the issue's
author as actor, although the bot closed it: a polled issue row has the
issue's body, so the mention in it counts again, and it has no closer. The
same holds for the `issue.edited` row a comment produces (D1 above). With the
example recipes' `github-direct-address` rule, a bot comment on an issue
that mentions the bot therefore wakes the bot again on the next pass. The
webhook path does not have this: a comment produces no `issues` delivery, and
a close carries its sender.

The fix has three parts. A polled issue row is delivered only when its state,
title or body changed since the last pass, the same way amendment 2a treats a
pull request's head; a closed pull request is announced once. A polled close
is attributed to `closed_by`, which the issues list carries, so the bot's own
close is from-self. And `chat:mention` counts only on events that bring their
text (opened, edited, a comment, a review), never on a close, a reopen or a
push, on either path. `test/poller.test.ts` replays the rehearsal: the bot's
comment yields the comment alone, the bot's close comes back as the bot's, and
a human comment on the closed issue yields no second close.

Checked live on the same host with `a729311` against issue #11: the polled
events were `issue.opened` (human, mention), the bot's `comment.created`
(from-self) with no issue row beside it, `issue.closed` attributed to the bot
(from-self), and the human's later comment alone, with no second close.

Sandbox writes of this rehearsal: issue #10 opened by the maintainer account,
two bot comments, #10 closed by the bot. Nothing merged.
