/**
 * Polling ingress (TASK-SRHKG.1.3, §Ingress, as amended by contract
 * amendment 1).
 *
 * The contract's first draft polled `GET /notifications`; an App installation
 * token cannot read that endpoint, so the fallback asks the repository what
 * changed since its cursor instead — `listIssuesSince`,
 * `listIssueCommentsSince`, `listReviewCommentsSince` — and derives the check
 * state of the open pull-request heads it saw from `getCheckRuns`.
 *
 * Two properties the acceptance criteria name, and where they live:
 *
 *   - **The interval floor.** `effectiveIntervalMs` is never below
 *     `MIN_POLL_INTERVAL_MS` (60 s) and never below GITHUB_POLL_INTERVAL_MS;
 *     a server-sent `X-Poll-Interval` can only raise it, through
 *     {@link Poller.observePollInterval}.
 *   - **Record only after delivery.** The dedup ring is read once per pass
 *     and a key is written back only once its event has been handed to the
 *     listener without throwing, so a failed delivery is re-attempted on the
 *     next pass instead of being silently consumed. The cursor advances for
 *     the same reason: only when the whole pass delivered.
 */

import {
  CheckGate,
  checkMarkOf,
  checksPollKey,
  isCompletedSummary,
  normalizePolledChecks,
  normalizePolledComment,
  normalizePolledIssue,
  polledMarker,
  pollKey,
  type PollRowKind,
} from './normalize.js';
import {
  channelId,
  MIN_POLL_INTERVAL_MS,
  repoSlug,
  silentLogger,
  type GitHubApi,
  type Logger,
  type ChecksSummary,
  type NormalizedEvent,
  type PolledComment,
  type PolledIssue,
  type RepoRef,
  type ThreadRef,
} from './types.js';
import type { EventListener } from './webhook.js';
import { POLL_MAX_ENTRIES } from './github-adapter.js';

/** True when `at` is at or after `since`; an unreadable stamp answers false. */
const atOrAfterInstant = (at: string, since: string): boolean => {
  const x = Date.parse(at);
  const y = Date.parse(since);
  return Number.isFinite(x) && Number.isFinite(y) && x >= y;
};

/** Amendment 1: "at most 20 PRs per poll" get their check runs fetched. */
export const MAX_CHECKED_PULLS_PER_POLL = 20;

/**
 * How many pull-request heads may wait for a check lookup at once.
 *
 * The backlog exists because the issue cursor is not a work queue: it moves
 * forward whether or not the check lookups it implied succeeded, so a head
 * whose lookup failed, or that the {@link MAX_CHECKED_PULLS_PER_POLL} cap cut
 * off, or whose runs had not finished yet, would otherwise be dropped and
 * never asked about again. At the 60 s floor and 20 lookups a pass, this many
 * heads drain in ten minutes; past it the oldest head is forgotten, which
 * bounds the backlog against a repository that updates pull requests faster
 * than the poller can check them.
 */
export const MAX_HEAD_BACKLOG = 200;

/**
 * How many passes a head may report nothing — a failing lookup, or a sha with
 * no check runs at all — before the poller gives up on it. A head whose runs
 * are merely still going does not spend an attempt: that is progress, and CI
 * is allowed to take longer than ten minutes.
 */
export const MAX_HEAD_ATTEMPTS = 10;

/**
 * How many threads' closes the `arrivals` scope remembers, in memory, to
 * tell a reopen by. Kept apart from the durable head memory, whose 200
 * entries hold the notifications poller's thread cursors.
 */
export const ARRIVALS_MARKER_MEMORY = 1000;

/** The part of {@link GitHubApi} the poller uses. */
export type PollerApi = Pick<
  GitHubApi,
  'listIssuesSince' | 'listIssueCommentsSince' | 'listReviewCommentsSince' | 'getCheckRuns'
>;

/**
 * The durable state the poller needs: the cursor, the dedup ring and the last
 * polled head of each open pull request (amendment 2a). A structural subset of
 * `StateStore` (types.ts), which .7 implements over GITHUB_STATE_FILE —
 * `snapshot()` is in the interface so that the ring can be *read* without
 * being written to, which is what lets a key be recorded only after its event
 * was delivered.
 */
export interface IngressState {
  lastPollAt(): string | null;
  setLastPollAt(when: string): void;
  /** Records `key` in the ring and reports whether it was already there. */
  seenPollKey(key: string): boolean;
  /** The head sha the last pass recorded for this pull request, or null. */
  polledHead(channel: string): string | null;
  setPolledHead(channel: string, sha: string): void;
  /** Read-only view; the poller reads `pollKeys` once per pass. */
  snapshot(): { pollKeys: string[] };
}

/**
 * What a pass delivers. `all` is App mode's repository poll. `arrivals` is
 * contributor mode's owned-repository poll (owned-repos.ts), which the
 * notifications poller runs beside its own pass: an issue or pull request
 * opened or reopened, and a conversation comment posted, by anyone but
 * {@link PollerOptions.login}. It reads no review comments and looks up no
 * checks, and drops every other row at collection, keeping only its marker,
 * so a later reopen can be told from an edit.
 */
export type PollScope = 'all' | 'arrivals';

export interface PollerOptions {
  api: PollerApi;
  /** GITHUB_REPOS. The poller only ever asks these repositories. */
  repos: readonly RepoRef[];
  /** Default `all`. */
  scope?: PollScope;
  /** The token's login, whose own openings and comments the `arrivals` scope leaves out. */
  login?: string;
  state: IngressState;
  /** GITHUB_POLL_INTERVAL_MS. 0 means polling is off and `start()` is a no-op. */
  intervalMs: number;
  onEvent: EventListener;
  logger?: Logger;
  /** Overridable in tests. */
  now?: () => Date;
  maxCheckedPulls?: number;
  maxHeadBacklog?: number;
  maxHeadAttempts?: number;
  /**
   * The "one `checks.completed` per head sha" gate. Pass the webhook
   * listener's own gate when both ingress paths are live, so an emission from
   * one path is serialized against the other instead of racing it.
   */
  checkGate?: CheckGate;
}

/** What one pass did, for the caller's diagnostics and for the tests. */
export interface PollResult {
  /** The `since` the pass queried with. */
  since: string;
  /** Events handed to the listener, in order. */
  delivered: NormalizedEvent[];
  /** Candidates whose key was already in the ring. */
  duplicates: number;
  /** Events whose listener threw; their keys were not recorded. */
  failed: number;
  /** Whether the cursor was advanced to the start of this pass. */
  cursorAdvanced: boolean;
  /** `getCheckRuns` calls this pass made; never above the cap. */
  checkLookups: number;
  /** Heads still waiting for a conclusion when the pass ended. */
  checksBacklog: number;
}

/**
 * A pull-request head waiting for its check runs to settle. Held across
 * passes, keyed `<owner>/<name>@<sha>`, independent of the issue cursor.
 */
/**
 * What became of one hand-off: the listener took it, or another accepted
 * emission for the same head sha already covered it. A refusal throws.
 */
type HandOff = 'delivered' | 'covered';

interface PendingHead {
  repo: RepoRef;
  sha: string;
  number: number;
  html_url: string;
  /** The row's `updated_at`, kept so a check candidate sorts chronologically. */
  at: string;
  /** Passes that reported nothing; {@link MAX_HEAD_ATTEMPTS} gives up. */
  attempts: number;
}

interface Candidate {
  key: string;
  event: NormalizedEvent;
  /** Sort key: the row's `updated_at`, so a pass delivers chronologically. */
  at: string;
  /**
   * The backlog entry this candidate settles, if any. The head is retired
   * only once the listener has accepted the event (or the ring confirms it was
   * already delivered): a head removed at lookup time would be unrecoverable
   * once the cursor had moved past the pull-request row that queued it.
   */
  retires?: string;
  /**
   * The pull-request head this candidate's event announces, committed to
   * `pollHeads` on exactly the same terms as {@link Candidate.retires}:
   * **only once the listener has accepted the event.**
   *
   * Writing it at collection time lost a refused `pull.synchronize` for good
   * (review round 2, finding 1). The cursor is held back by the refusal, so
   * the row is queried again — but the next pass compared it against the head
   * already saved, found no change, dropped the row, and let the cursor move
   * on. The commits were never announced and nothing retried them, which is
   * exactly the guarantee {@link Poller.pollOnce} documents. A row that
   * produced *no* event is different: its head did not move, so recording it
   * at collection time loses nothing.
   */
  head?: { channel: string; sha: string };
}

export class Poller {
  private readonly api: PollerApi;
  private repos: readonly RepoRef[];
  private readonly scope: PollScope;
  private readonly login: string;
  /** The `arrivals` scope's markers, by channel, oldest first. */
  private readonly arrivalMarkers = new Map<string, string>();
  private readonly state: IngressState;
  private readonly configuredIntervalMs: number;
  private readonly onEvent: EventListener;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly maxCheckedPulls: number;
  private readonly maxHeadBacklog: number;
  private readonly maxHeadAttempts: number;
  private readonly checkGate: CheckGate;
  /**
   * Heads waiting for a conclusion, oldest first. Insertion order is the
   * drain order, and a head the pass could not settle is moved to the back,
   * so a backlog longer than the per-pass cap still drains round-robin.
   */
  private readonly backlog = new Map<string, PendingHead>();
  /** The last `X-Poll-Interval` the API reported, in ms. Can only raise. */
  private serverIntervalMs = 0;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private pass: Promise<unknown> = Promise.resolve();

  constructor(opts: PollerOptions) {
    this.api = opts.api;
    this.repos = opts.repos;
    this.scope = opts.scope ?? 'all';
    this.login = (opts.login ?? '').toLowerCase();
    this.state = opts.state;
    this.configuredIntervalMs = opts.intervalMs;
    this.onEvent = opts.onEvent;
    this.logger = opts.logger ?? silentLogger();
    this.now = opts.now ?? (() => new Date());
    this.maxCheckedPulls = opts.maxCheckedPulls ?? MAX_CHECKED_PULLS_PER_POLL;
    this.maxHeadBacklog = opts.maxHeadBacklog ?? MAX_HEAD_BACKLOG;
    this.maxHeadAttempts = opts.maxHeadAttempts ?? MAX_HEAD_ATTEMPTS;
    this.checkGate = opts.checkGate ?? new CheckGate();
  }

  /** The repositories the next pass asks; the owned-repository poll narrows them as permissions change. */
  setRepos(repos: readonly RepoRef[]): void {
    this.repos = repos;
  }

  /** Heads still waiting for their check runs to settle. */
  get checkBacklogSize(): number {
    return this.backlog.size;
  }

  /** GITHUB_POLL_INTERVAL_MS = 0: polling off. */
  get enabled(): boolean {
    return this.configuredIntervalMs > 0;
  }

  /**
   * The delay the next pass waits. The 60 s floor and GITHUB_POLL_INTERVAL_MS
   * are both floors, and a server-sent interval can only push it up.
   */
  get effectiveIntervalMs(): number {
    return Math.max(MIN_POLL_INTERVAL_MS, this.configuredIntervalMs, this.serverIntervalMs);
  }

  /**
   * Honour an `X-Poll-Interval` response header (seconds). Returns the
   * interval now in force. A value that would poll faster than the floor is
   * recorded but cannot lower it.
   */
  observePollInterval(value: string | number | null | undefined): number {
    const seconds = typeof value === 'string' ? Number(value.trim()) : typeof value === 'number' ? value : NaN;
    if (!Number.isFinite(seconds) || seconds <= 0) return this.effectiveIntervalMs;
    const asMs = Math.round(seconds * 1000);
    if (asMs !== this.serverIntervalMs) {
      this.serverIntervalMs = asMs;
      this.logger.info('poll interval reported by the API', {
        headerSeconds: seconds,
        effectiveMs: this.effectiveIntervalMs,
      });
    }
    return this.effectiveIntervalMs;
  }

  /** Start the loop. The first pass runs after one interval, not immediately. */
  start(): void {
    if (!this.enabled || this.running) return;
    this.running = true;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Resolve once the in-flight pass, if any, has finished. */
  async whenIdle(): Promise<void> {
    await this.pass;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      const pass = this.pollOnce()
        .catch((err: unknown) => {
          this.logger.error('poll pass failed', { error: err instanceof Error ? err.message : String(err) });
        })
        .finally(() => this.schedule());
      this.pass = pass;
    }, this.effectiveIntervalMs);
    // A poll timer must never be the reason the process stays alive.
    this.timer.unref?.();
  }

  /**
   * One pass: query every allow-listed repository since the cursor, drain as
   * much of the check backlog as the per-pass cap allows, drop what the dedup
   * ring already holds, deliver the rest oldest-first, record each key after
   * its delivery, and advance the cursor if no delivery failed.
   *
   * A failed *lookup* does not hold the cursor back: the head stays in the
   * backlog instead, which is the thing that gets retried. A failed
   * *delivery* does hold it back, so its row is queried again.
   *
   * For that retry to mean anything, nothing a refused event would be
   * recognised by on the next pass may be written before it is accepted. Two
   * things are therefore committed inside the delivery loop and nowhere else:
   * the dedup key, and the pull-request head a `pull.synchronize` announces
   * ({@link Candidate.head}).
   */
  async pollOnce(seen?: ReadonlySet<string>): Promise<PollResult> {
    const startedAt = this.now();
    const since = this.state.lastPollAt() ?? new Date(startedAt.getTime() - this.effectiveIntervalMs).toISOString();
    const receivedAt = startedAt.toISOString();

    const candidates: Candidate[] = [];
    // Where the cursor may move to: the pass's start, or, when a list stopped
    // at the adapter's cap, the last row it got, so the rest come next pass.
    let advanceTo = receivedAt;
    for (const repo of this.repos) {
      const rows = await this.collectRows(repo, since, receivedAt);
      candidates.push(...rows.candidates);
      if (rows.holdAt !== null && rows.holdAt < advanceTo) advanceTo = rows.holdAt;
    }
    // One drain for every repository together, so the cap is a cap on the
    // pass and not on each repository in turn.
    const checks = await this.drainHeadBacklog(receivedAt);
    candidates.push(...checks.candidates);
    candidates.sort((a, b) => (a.at === b.at ? a.key.localeCompare(b.key) : a.at.localeCompare(b.at)));

    // One read of the ring per pass: the write happens after delivery. A
    // caller running another ingress in the same pass passes what that one
    // delivered, which the bounded ring may no longer hold.
    const alreadySeen = new Set(this.state.snapshot().pollKeys);
    for (const key of seen ?? []) alreadySeen.add(key);
    const result: PollResult = {
      since,
      delivered: [],
      duplicates: 0,
      failed: 0,
      cursorAdvanced: false,
      checkLookups: checks.lookups,
      // Filled in after the delivery loop: a head is only retired once its
      // event has been accepted, so the size before the loop means nothing.
      checksBacklog: 0,
    };
    const deliveredThisPass = new Set<string>();

    for (const candidate of candidates) {
      // A head leaves the backlog once this event is known to be delivered —
      // by this pass, or by an earlier one, or by the webhook path.
      const retire = (): void => {
        if (candidate.retires !== undefined) this.backlog.delete(candidate.retires);
      };
      // Committed on exactly the terms `retire` is: the listener took the
      // event, or the ring says an earlier pass already got it through.
      const commitHead = (): void => {
        if (candidate.head) this.setMarker(candidate.head.channel, candidate.head.sha);
      };

      if (alreadySeen.has(candidate.key) || deliveredThisPass.has(candidate.key)) {
        result.duplicates += 1;
        retire();
        commitHead();
        continue;
      }

      let outcome: HandOff;
      try {
        outcome = await this.hand(candidate.event);
      } catch (err) {
        // Nothing is recorded and nothing is retired: the key stays out of
        // the dedup ring, the head stays in the backlog, and the cursor is
        // held back below, so the next pass tries again.
        result.failed += 1;
        this.logger.warn('poll event delivery failed; its key stays unrecorded for the next pass', {
          key: candidate.key,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      if (outcome === 'covered') {
        // Another emission for this head sha was accepted and said everything
        // this one would have, so the head is done — not waiting on anybody.
        result.duplicates += 1;
        retire();
        this.logger.info('poll checks result dropped: this head sha already reported this result or a stronger one', {
          sha: candidate.event.sha,
          conclusion: candidate.event.checks?.conclusion ?? null,
        });
        continue;
      }

      // Recorded only now, after the listener took it.
      this.state.seenPollKey(candidate.key);
      deliveredThisPass.add(candidate.key);
      result.delivered.push(candidate.event);
      retire();
      commitHead();
    }

    result.checksBacklog = this.backlog.size;

    if (result.failed === 0) {
      this.state.setLastPollAt(advanceTo);
      if (advanceTo !== receivedAt) {
        this.logger.warn('poll cursor moved only to the last row a capped list returned; the rest come next pass', {
          since,
          cursor: advanceTo,
        });
      }
      result.cursorAdvanced = true;
    } else {
      this.logger.warn('poll cursor held back: a delivery failed in this pass', {
        since,
        failed: result.failed,
      });
    }
    this.logger.debug('poll pass done', {
      since,
      delivered: result.delivered.length,
      duplicates: result.duplicates,
      failed: result.failed,
      checkLookups: result.checkLookups,
      checksBacklog: result.checksBacklog,
    });
    return result;
  }

  // ── One repository's rows ──

  /**
   * The issue, comment and review-comment rows one repository changed since
   * the cursor. Every open pull-request head it saw is *enqueued* for a check
   * lookup rather than looked up here, so the cap and the retries belong to
   * the backlog and not to one repository's turn.
   */
  private async collectRows(
    repo: RepoRef,
    since: string,
    receivedAt: string,
  ): Promise<{ candidates: Candidate[]; holdAt: string | null }> {
    const out: Candidate[] = [];
    // A list the adapter cut at its cap holds the cursor at its last row
    // (rows come oldest first); the ring drops the rows read twice.
    let holdAt: string | null = null;
    const hold = (rows: readonly { updatedAt: string }[]): void => {
      const last = rows[rows.length - 1]?.updatedAt;
      if (rows.length < POLL_MAX_ENTRIES || last === undefined) return;
      const at = Date.parse(last);
      // A cap filled within one second would hold the cursor in place for good: let it move.
      if (!Number.isFinite(at) || at <= Date.parse(since)) return;
      if (holdAt === null || at < Date.parse(holdAt)) holdAt = new Date(at).toISOString();
    };

    const issues = await this.api.listIssuesSince(repo, since);
    hold(issues);
    for (const row of issues) {
      // What the last pass recorded for this thread (amendment 2a for a pull
      // request's head, a state-and-text fingerprint for an issue) turns a
      // real change into an event and drops the row a comment only bumped.
      const channel = channelId({ repo, number: row.number, kind: row.isPullRequest ? 'pull' : 'issue' });
      const previous = this.marker(channel);
      const normalized = normalizePolledIssue(repo, row, receivedAt, since, previous);
      const event = this.scope === 'arrivals' ? this.arrival(repo, normalized, row, previous, receivedAt) : normalized;
      // A reopened pull request whose head the adapter didn't read still
      // needs its close replaced, or each later bump would reopen it again.
      const marker = polledMarker(row) ?? (event !== null && this.scope === 'arrivals' ? 'open' : undefined);
      const openHead =
        this.scope === 'all' && row.isPullRequest && row.state === 'open' && row.headSha ? row.headSha : undefined;
      if (event) {
        // The marker rides with the candidate and is committed on acceptance,
        // so a refusal leaves the poller still believing the old one and the
        // next pass announces the change again (finding 1). Deferring it also
        // means a `listIssueCommentsSince` that throws later in this very
        // method cannot leave a marker advanced for a pass that never delivered.
        out.push({
          key: pollKey('issue', row.id, row.updatedAt),
          event,
          at: row.updatedAt,
          ...(marker === undefined ? {} : { head: { channel, sha: marker } }),
        });
      } else if (marker !== undefined) {
        // No event: this row was dropped *because* the marker is unchanged, so
        // what is written here is the value already stored. It costs nothing
        // and refreshes the entry's place in the eviction order, which is why
        // a long-lived thread is not evicted ahead of ones nobody has looked
        // at since.
        //
        // The `arrivals` scope also lands here for every row it leaves out,
        // and needs a marker only to tell a reopen by: it keeps a close's,
        // and writes no other, so the head memory it shares with the
        // notifications poller's thread cursors turns over only as fast as
        // threads close.
        if (this.scope === 'all' || row.state === 'closed') this.setMarker(channel, marker);
      }
      if (openHead !== undefined) this.enqueueHead(repo, row);
    }

    let comments = await this.api.listIssueCommentsSince(repo, since);
    hold(comments);
    if (this.scope === 'arrivals') {
      // Posted since the cursor, by someone else: an edit bumps `updated_at`
      // as a post does, and is no arrival. A row that doesn't say when it
      // was posted counts as posted when it was last updated.
      comments = comments.filter((c) => !this.isSelf(c.author) && atOrAfterInstant(c.createdAt ?? c.updatedAt, since));
      return { candidates: [...out, ...this.commentCandidates(repo, comments, 'issue_comment', receivedAt)], holdAt };
    }
    out.push(...this.commentCandidates(repo, comments, 'issue_comment', receivedAt));
    const reviewComments = await this.api.listReviewCommentsSince(repo, since);
    hold(reviewComments);
    out.push(...this.commentCandidates(repo, reviewComments, 'review_comment', receivedAt));

    return { candidates: out, holdAt };
  }

  /** What was last recorded for a thread: the durable head memory, or the `arrivals` scope's own. */
  private marker(channel: string): string | undefined {
    return (this.scope === 'arrivals' ? this.arrivalMarkers.get(channel) : this.state.polledHead(channel)) ?? undefined;
  }

  private setMarker(channel: string, value: string): void {
    if (this.scope === 'all') {
      this.state.setPolledHead(channel, value);
      return;
    }
    this.arrivalMarkers.delete(channel);
    this.arrivalMarkers.set(channel, value);
    if (this.arrivalMarkers.size > ARRIVALS_MARKER_MEMORY) {
      const oldest = this.arrivalMarkers.keys().next();
      if (!oldest.done) this.arrivalMarkers.delete(oldest.value);
    }
  }

  /**
   * The `arrivals` scope's verdict on an issue row's event: an opening by
   * someone else as it is, a reopen as `issue.reopened`, or for a pull
   * request `pull.opened`, since the vocabulary has no reopen for one, and
   * null for anything else. A reopen is an open row whose last recorded
   * marker was a close; the row doesn't say who reopened it, so its actor is
   * the author, as every polled edit's is, and it isn't left out as the
   * user's own.
   */
  private arrival(
    repo: RepoRef,
    event: NormalizedEvent | null,
    row: PolledIssue,
    previous: string | undefined,
    receivedAt: string,
  ): NormalizedEvent | null {
    if (event !== null && (event.kind === 'issue.opened' || event.kind === 'pull.opened')) {
      return this.isSelf(event.actor) ? null : event;
    }
    const reopened = row.state === 'open' && previous !== undefined && (previous === 'closed' || previous.startsWith('issue:closed:'));
    if (!reopened) return null;
    // Built as an opening (since = its creation), so a pull request whose
    // head the adapter didn't read, which normalizes to nothing, still has one.
    const built = event ?? normalizePolledIssue(repo, row, receivedAt, row.createdAt);
    return built === null ? null : { ...built, kind: row.isPullRequest ? 'pull.opened' : 'issue.reopened' };
  }

  private isSelf(actor: { login: string } | undefined): boolean {
    return this.login !== '' && actor !== undefined && actor.login.toLowerCase() === this.login;
  }

  // ── The check backlog ──

  /** Remember a head to check. An already-queued head keeps its place. */
  private enqueueHead(repo: RepoRef, row: PolledIssue): void {
    const sha = row.headSha as string;
    const key = CheckGate.key(repo, sha);
    const queued = this.backlog.get(key);
    if (queued) {
      // Same head seen again: refresh what the event will say, keep the
      // queue position and the attempt count.
      queued.at = row.updatedAt;
      queued.html_url = row.html_url;
      queued.number = row.number;
      return;
    }
    this.backlog.set(key, {
      repo,
      sha,
      number: row.number,
      html_url: row.html_url,
      at: row.updatedAt,
      attempts: 0,
    });
    if (this.backlog.size > this.maxHeadBacklog) {
      const oldest = this.backlog.keys().next();
      if (!oldest.done) {
        this.backlog.delete(oldest.value);
        this.logger.warn('poll head backlog full; forgot the oldest head waiting for checks', {
          forgot: oldest.value,
          cap: this.maxHeadBacklog,
        });
      }
    }
  }

  /**
   * Ask about as many waiting heads as the per-pass cap allows, oldest first.
   * A head that settled leaves the backlog with a candidate; a head that did
   * not is moved to the back, so the next pass starts with someone else and a
   * long backlog drains round-robin instead of starving behind the same 20.
   */
  private async drainHeadBacklog(receivedAt: string): Promise<{ candidates: Candidate[]; lookups: number }> {
    const due = [...this.backlog.values()].slice(0, this.maxCheckedPulls);
    if (this.backlog.size > due.length) {
      this.logger.info('poll check lookups capped; the rest of the backlog waits for the next pass', {
        cap: this.maxCheckedPulls,
        waiting: this.backlog.size - due.length,
      });
    }

    const candidates: Candidate[] = [];
    let lookups = 0;
    for (const head of due) {
      const key = CheckGate.key(head.repo, head.sha);
      lookups += 1;
      let summary: ChecksSummary;
      try {
        summary = await this.api.getCheckRuns(head.repo, head.sha);
      } catch (err) {
        this.retainHead(key, head, 'the check runs lookup failed', err);
        continue;
      }

      if (!isCompletedSummary(summary)) {
        if (summary.total === 0) {
          // Nothing is running on this sha and nothing has run: it may be a
          // head no workflow matches, so it ages out rather than waiting.
          this.retainHead(key, head, 'the head has no check runs');
        } else {
          // Runs exist and have not finished: `checks.completed` would be a
          // lie, so wait — and do not spend an attempt on real progress.
          this.rotateHead(key, head);
          this.logger.debug('poll head still running its checks', { sha: head.sha, runs: summary.total });
        }
        continue;
      }

      // Settled — but the head stays queued until the delivery loop retires
      // it, so a refused event can be retried even after the cursor has moved
      // past the pull-request row that queued this head (rule 2).
      this.rotateHead(key, head);
      const pull: ThreadRef = { repo: head.repo, number: head.number, kind: 'pull' };
      candidates.push({
        key: checksPollKey(summary),
        event: normalizePolledChecks(head.repo, pull, summary, head.html_url, receivedAt),
        at: head.at,
        retires: key,
      });
    }
    return { candidates, lookups };
  }

  /**
   * Hand one event to the listener. A `checks.completed` event goes through
   * the gate, which serializes it against every other emission for its head
   * sha and reports whether what the listener already accepted covers it; any
   * other event goes straight out. A refusal propagates.
   */
  private async hand(event: NormalizedEvent): Promise<HandOff> {
    const mark = checkMarkOf(event);
    if (mark === null) {
      await this.onEvent(event);
      return 'delivered';
    }
    const delivered = await this.checkGate.emit(event.repo, event.sha as string, mark, async () => {
      await this.onEvent(event);
    });
    return delivered ? 'delivered' : 'covered';
  }

  /** Keep a head that reported nothing, until it has used up its attempts. */
  private retainHead(key: string, head: PendingHead, why: string, err?: unknown): void {
    head.attempts += 1;
    const fields = {
      repo: repoSlug(head.repo),
      sha: head.sha,
      attempts: head.attempts,
      why,
      ...(err === undefined ? {} : { error: err instanceof Error ? err.message : String(err) }),
    };
    if (head.attempts >= this.maxHeadAttempts) {
      this.backlog.delete(key);
      this.logger.warn('poll gave up on a pull-request head after too many empty passes', fields);
      return;
    }
    this.rotateHead(key, head);
    this.logger.debug('poll will ask about this head again next pass', fields);
  }

  /** Move to the back of the queue: a Map keeps insertion order. */
  private rotateHead(key: string, head: PendingHead): void {
    this.backlog.delete(key);
    this.backlog.set(key, head);
  }

  private commentCandidates(
    repo: RepoRef,
    rows: readonly PolledComment[],
    kind: Extract<PollRowKind, 'issue_comment' | 'review_comment'>,
    receivedAt: string,
  ): Candidate[] {
    return rows.map((row) => ({
      key: pollKey(kind, row.id, row.updatedAt),
      event: normalizePolledComment(repo, row, kind, receivedAt),
      at: row.updatedAt,
    }));
  }
}
