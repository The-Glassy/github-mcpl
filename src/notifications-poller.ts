/**
 * Notifications ingress (contributor mode).
 *
 * App mode's two ingress paths — the webhook and the repository poll
 * (poller.ts) — both need an installation token's repository-scoped reads.
 * A user token has no installation and no webhook to receive, but it can read
 * `GET /notifications?participating=true`: every thread the token's own user
 * is participating in, across every repository they can reach, not only
 * GITHUB_REPOS. That is this module's ingress, and it is the only one
 * contributor mode runs (readConfig refuses GITHUB_WEBHOOK_PORT in this mode).
 *
 * The endpoint itself is cheap to poll: `If-Modified-Since` / `Last-Modified`
 * make an unchanged inbox a 304 (`NotificationsPage.notModified`, no body),
 * and a `X-Poll-Interval` response header can only raise the floor this
 * poller already holds it to ({@link MIN_POLL_INTERVAL_MS}), exactly like the
 * repository poll's `observePollInterval`.
 *
 * What is expensive is the notification list itself: it says only *that* a
 * thread changed, never *what*, so for every thread with a subject this
 * ingress maps (`Issue` or `PullRequest`; anything else — a commit, a
 * discussion, a release — is dropped) this poller re-reads that one thread:
 * its comments since the thread's own cursor ({@link GitHubApi.listComments}),
 * a pull request's review comments and submitted reviews since the same
 * cursor, and whether its state changed. Every one of those is normalized by
 * the *same* pure functions App mode's poll and webhook ingress use
 * (normalize.ts's `normalizePolledComment` and the new `normalizePolledReview`),
 * so a comment or a review reaching the model this way carries the same tags,
 * metadata and channel as it would under a webhook or a repository poll — the
 * difference is only which GitHub endpoint noticed it.
 *
 * Durable state is the existing {@link StateStore} seam (state.ts), reused
 * rather than widened:
 *
 *   - `lastPollAt`/`setLastPollAt` hold the notifications endpoint's own
 *     `Last-Modified`, not an ISO instant — App mode and contributor mode
 *     never run in the same process, so the field's meaning never has to be
 *     disambiguated at the call site.
 *   - `seenPollKey` is the same dedup ring the repository poll uses. A key is
 *     always `event.id` (`poll:<kind>:<github-id>:<timestamp>`), which is
 *     stable across a restart because every component of it — the kind, the
 *     id GitHub itself assigned, and the row's own timestamp — is.
 *   - `polledHead`/`setPolledHead` hold one packed string per thread channel:
 *     the content cursor ("new since here") and the state marker ("what the
 *     thread looked like last"), so no new per-thread map is needed either.
 *
 * Nothing is marked read on GitHub unless `markRead` is set (default off, the
 * task's "optional, behind a flag defaulting off"), and even then only after
 * every one of a thread's events delivered without throwing — the same
 * "commit only after delivery" discipline poller.ts documents, so a crash or
 * a refused delivery is retried instead of silently dropped because the
 * notification had already been marked read.
 */

import { createHash } from 'node:crypto';
import { normalizePolledComment, normalizePolledReview } from './normalize.js';
import {
  MIN_POLL_INTERVAL_MS,
  channelId,
  silentLogger,
  type Comment,
  type Issue,
  type Logger,
  type NormalizedEvent,
  type NormalizedEventKind,
  type PolledComment,
  type PolledReview,
  type PullRequest,
  type RepoRef,
  type ThreadKind,
  type ThreadRef,
} from './types.js';
import type { EventListener } from './webhook.js';
import type { NotificationRow, NotificationsPage } from './github-adapter.js';

/** The adapter surface this ingress uses. A structural subset — `GitHubAdapter` satisfies it with no cast. */
export interface NotificationsPollerApi {
  listNotifications(ifModifiedSince: string | null): Promise<NotificationsPage>;
  listComments(thread: ThreadRef, since?: string): Promise<Comment[]>;
  listReviewCommentsSince(repo: RepoRef, since: string): Promise<PolledComment[]>;
  listReviewsSince(pull: ThreadRef, since: string): Promise<PolledReview[]>;
  getIssue(ref: ThreadRef): Promise<Issue>;
  getPullRequest(ref: ThreadRef): Promise<PullRequest>;
  markNotificationThreadRead(threadId: string): Promise<void>;
}

/**
 * The durable state this ingress needs: the same shape poller.ts's
 * `IngressState` declares (structurally identical to `StateStore`'s own
 * subset), so `state.ts`'s `GithubState` satisfies this with no adapter.
 */
export interface NotificationsIngressState {
  lastPollAt(): string | null;
  setLastPollAt(when: string): void;
  seenPollKey(key: string): boolean;
  polledHead(channel: string): string | null;
  setPolledHead(channel: string, value: string): void;
  snapshot(): { pollKeys: string[] };
}

export interface NotificationsPollerOptions {
  api: NotificationsPollerApi;
  state: NotificationsIngressState;
  /** GITHUB_POLL_INTERVAL_MS. readConfig floors and defaults this in contributor mode, so it is never 0 in practice. */
  intervalMs: number;
  onEvent: EventListener;
  logger?: Logger;
  /** Overridable in tests. */
  now?: () => Date;
  /** GITHUB_MARK_NOTIFICATIONS_READ. Default off. */
  markRead?: boolean;
}

/** What one pass did, for diagnostics and for the tests. */
export interface NotificationsPollResult {
  /** True on a 304: nothing else in this result is populated. */
  notModified: boolean;
  /** Threads with a mapped subject this pass looked at. */
  threads: number;
  delivered: NormalizedEvent[];
  duplicates: number;
  /** Deliveries (or a whole thread's lookup) that threw; retried next pass. */
  failed: number;
}

/** One packed `polledHead` value: the per-thread content cursor and state marker. */
const CURSOR_SEP = '\u0000';

function packCursor(since: string, marker: string): string {
  return `${since}${CURSOR_SEP}${marker}`;
}

function unpackCursor(value: string | null): { since: string | null; marker: string | undefined } {
  if (value === null) return { since: null, marker: undefined };
  const at = value.indexOf(CURSOR_SEP);
  if (at < 0) return { since: value, marker: undefined };
  const marker = value.slice(at + 1);
  return { since: value.slice(0, at), marker: marker === '' ? undefined : marker };
}

/**
 * What the last pass saw of a thread's own state, so a comment's bump (which
 * touches nothing here) can be told from a real state change — the same idea
 * as normalize.ts's `polledMarker`, computed from the mapped `Issue`/
 * `PullRequest` the tool contract already exposes rather than from the
 * `PolledIssue` row only the repository poll's list endpoints produce.
 */
function stateMarkerOf(kind: ThreadKind, data: Issue | PullRequest): string {
  if (kind === 'pull') {
    const pull = data as PullRequest;
    return pull.state === 'closed' ? 'closed' : pull.head.sha || 'unknown';
  }
  const issue = data as Issue;
  const text = createHash('sha256').update(`${issue.title}\0${issue.body}`).digest('hex').slice(0, 16);
  return `issue:${issue.state}:${text}`;
}

/**
 * Decide whether the marker moving means an event, and which one — mirrors
 * normalize.ts's `normalizePolledIssue` kind decision, but has no
 * `PolledIssue.id` to key a dedup entry on, so the caller builds `id` and this
 * only supplies the kind (or null: nothing reportable moved).
 *
 * A pull request's `closed → open` (reopened) is dropped, not reported: the
 * contract has no `pull.reopened` kind, the same gap `normalizeWebhook` and
 * the repository poll both already have.
 */
function stateChangeKind(
  kind: ThreadKind,
  data: Issue | PullRequest,
  previousMarker: string,
  marker: string,
): NormalizedEventKind | null {
  if (kind === 'pull') {
    const pull = data as PullRequest;
    if (pull.state === 'closed') return 'pull.closed';
    if (previousMarker === 'closed') return null;
    return marker !== previousMarker ? 'pull.synchronize' : null;
  }
  const issue = data as Issue;
  if (issue.state === 'closed') return 'issue.closed';
  return previousMarker.startsWith('issue:closed:') ? 'issue.reopened' : 'issue.edited';
}

/** One candidate event, with the ring key it is delivered and recorded under. */
interface Candidate {
  key: string;
  event: NormalizedEvent;
  at: string;
}

export class NotificationsPoller {
  private readonly api: NotificationsPollerApi;
  private readonly state: NotificationsIngressState;
  private readonly configuredIntervalMs: number;
  private readonly onEvent: EventListener;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly markRead: boolean;
  /** The last `X-Poll-Interval` the API reported, in ms. Can only raise. */
  private serverIntervalMs = 0;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private pass: Promise<unknown> = Promise.resolve();

  constructor(opts: NotificationsPollerOptions) {
    this.api = opts.api;
    this.state = opts.state;
    this.configuredIntervalMs = opts.intervalMs;
    this.onEvent = opts.onEvent;
    this.logger = opts.logger ?? silentLogger();
    this.now = opts.now ?? (() => new Date());
    this.markRead = opts.markRead ?? false;
  }

  get enabled(): boolean {
    return this.configuredIntervalMs > 0;
  }

  /** Same floor rule as poller.ts's `Poller.effectiveIntervalMs`. */
  get effectiveIntervalMs(): number {
    return Math.max(MIN_POLL_INTERVAL_MS, this.configuredIntervalMs, this.serverIntervalMs);
  }

  /** Honour `X-Poll-Interval` (seconds); can only raise the interval, never lower it below the floor. */
  observePollInterval(seconds: number | null): number {
    if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return this.effectiveIntervalMs;
    const asMs = Math.round(seconds * 1000);
    if (asMs !== this.serverIntervalMs) {
      this.serverIntervalMs = asMs;
      this.logger.info('poll interval reported by the notifications API', {
        headerSeconds: seconds,
        effectiveMs: this.effectiveIntervalMs,
      });
    }
    return this.effectiveIntervalMs;
  }

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

  async whenIdle(): Promise<void> {
    await this.pass;
  }

  private schedule(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      const pass = this.pollOnce()
        .catch((err: unknown) => {
          this.logger.error('notifications poll pass failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => this.schedule());
      this.pass = pass;
    }, this.effectiveIntervalMs);
    this.timer.unref?.();
  }

  /**
   * One pass: ask `GET /notifications` since the last `Last-Modified`; a 304
   * costs nothing more. Otherwise, for every thread this ingress maps, fetch
   * what is new since that thread's own cursor, deliver it, and advance that
   * thread's cursor only once every one of its events has been accepted —
   * exactly the "record only after delivery" rule poller.ts documents.
   */
  async pollOnce(): Promise<NotificationsPollResult> {
    const startedAt = this.now();
    const receivedAt = startedAt.toISOString();
    const ifModifiedSince = this.state.lastPollAt();

    const page = await this.api.listNotifications(ifModifiedSince);
    this.observePollInterval(page.pollIntervalSeconds);

    const result: NotificationsPollResult = {
      notModified: page.notModified,
      threads: 0,
      delivered: [],
      duplicates: 0,
      failed: 0,
    };
    if (page.notModified) {
      this.logger.debug('notifications poll: not modified', { ifModifiedSince });
      return result;
    }

    const relevant = page.notifications.filter(
      (n): n is NotificationRow & { kind: ThreadKind; number: number } => n.kind !== null && n.number !== null,
    );
    result.threads = relevant.length;

    // Read once per pass; a key is written back only once its event is
    // delivered (see `deliverThread`).
    const alreadySeen = new Set(this.state.snapshot().pollKeys);
    const bootstrapSince = new Date(startedAt.getTime() - this.effectiveIntervalMs).toISOString();
    let anyFailed = false;

    for (const notification of relevant) {
      const thread: ThreadRef = { repo: notification.repo, number: notification.number, kind: notification.kind };
      const outcome = await this.pollThread(thread, notification, bootstrapSince, receivedAt, alreadySeen);
      result.delivered.push(...outcome.delivered);
      result.duplicates += outcome.duplicates;
      result.failed += outcome.failed;
      if (outcome.failed > 0) anyFailed = true;
    }

    // The whole pass's Last-Modified only sticks if nothing failed: GitHub's
    // conditional request has no finer grain than "since this instant", so
    // holding it back is what makes a failed thread's row reappear next pass.
    if (!anyFailed) {
      this.state.setLastPollAt(page.lastModified ?? receivedAt);
    } else {
      this.logger.warn('notifications poll: Last-Modified held back; at least one thread failed this pass', {
        threads: relevant.length,
      });
    }

    return result;
  }

  /** Fetch, normalize and deliver one notification thread's new activity. */
  private async pollThread(
    thread: ThreadRef,
    notification: NotificationRow,
    bootstrapSince: string,
    receivedAt: string,
    alreadySeen: ReadonlySet<string>,
  ): Promise<{ delivered: NormalizedEvent[]; duplicates: number; failed: number }> {
    const channel = channelId(thread);
    const cursorKey = `notif:${channel}`;
    const previous = unpackCursor(this.state.polledHead(cursorKey));
    const sinceForThread = previous.since ?? bootstrapSince;

    let candidates: Candidate[];
    let marker: string;
    try {
      const built = await this.collectCandidates(thread, notification.repo, sinceForThread, previous.marker, receivedAt);
      candidates = built.candidates;
      marker = built.marker;
    } catch (err) {
      this.logger.warn('notifications poll: fetching one thread failed; it will be retried next pass', {
        channel,
        error: err instanceof Error ? err.message : String(err),
      });
      return { delivered: [], duplicates: 0, failed: 1 };
    }

    candidates.sort((a, b) => (a.at === b.at ? a.key.localeCompare(b.key) : a.at.localeCompare(b.at)));

    const delivered: NormalizedEvent[] = [];
    let duplicates = 0;
    let failed = 0;
    for (const candidate of candidates) {
      if (alreadySeen.has(candidate.key)) {
        duplicates += 1;
        continue;
      }
      try {
        await this.onEvent(candidate.event);
      } catch (err) {
        failed += 1;
        this.logger.warn('notifications poll: event delivery failed; its key stays unrecorded for the next pass', {
          key: candidate.key,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      this.state.seenPollKey(candidate.key);
      delivered.push(candidate.event);
    }

    // The cursor (and the optional mark-as-read) only move once this
    // thread's whole batch is through: a refused delivery must leave the
    // cursor where it was, or the row that produced it is never asked about
    // again.
    if (failed === 0) {
      this.state.setPolledHead(cursorKey, packCursor(receivedAt, marker));
      if (this.markRead) {
        try {
          await this.api.markNotificationThreadRead(notification.id);
        } catch (err) {
          // Best-effort: GitHub still has the thread as unread, which costs
          // nothing but a slightly noisier inbox.
          this.logger.warn('notifications poll: marking a thread read failed (harmless)', {
            id: notification.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return { delivered, duplicates, failed };
  }

  /** Every new comment, review comment, submitted review and state change on one thread. */
  private async collectCandidates(
    thread: ThreadRef,
    repo: RepoRef,
    since: string,
    previousMarker: string | undefined,
    receivedAt: string,
  ): Promise<{ candidates: Candidate[]; marker: string }> {
    const candidates: Candidate[] = [];

    for (const c of await this.api.listComments(thread, since)) {
      const row: PolledComment = {
        id: c.id,
        number: thread.number,
        author: c.author,
        body: c.body,
        updatedAt: c.updatedAt,
        html_url: c.html_url,
        ...(c.path !== undefined ? { path: c.path } : {}),
        ...(c.inReplyTo !== undefined ? { inReplyTo: c.inReplyTo } : {}),
      };
      const event = normalizePolledComment(repo, row, 'issue_comment', receivedAt);
      candidates.push({ key: event.id, event, at: row.updatedAt });
    }

    if (thread.kind === 'pull') {
      const reviewComments = (await this.api.listReviewCommentsSince(repo, since)).filter(
        (row) => row.number === thread.number,
      );
      for (const row of reviewComments) {
        const event = normalizePolledComment(repo, row, 'review_comment', receivedAt);
        candidates.push({ key: event.id, event, at: row.updatedAt });
      }

      for (const row of await this.api.listReviewsSince(thread, since)) {
        const event = normalizePolledReview(repo, thread, row, receivedAt);
        candidates.push({ key: event.id, event, at: row.submittedAt });
      }
    }

    const current = thread.kind === 'pull' ? await this.api.getPullRequest(thread) : await this.api.getIssue(thread);
    const marker = stateMarkerOf(thread.kind, current);
    if (previousMarker !== undefined && previousMarker !== marker) {
      const kind = stateChangeKind(thread.kind, current, previousMarker, marker);
      if (kind) {
        const key = `notif-state:${channelId(thread)}:${marker}`;
        candidates.push({
          key: `poll:${key}`,
          at: current.updatedAt,
          event: {
            id: `poll:${key}`,
            receivedAt,
            repo,
            kind,
            thread,
            actor: current.author,
            title: current.title,
            body: current.body,
            html_url: current.html_url,
            ...(thread.kind === 'pull' ? { sha: (current as PullRequest).head.sha } : {}),
            raw: current,
          },
        });
      }
    }

    return { candidates, marker };
  }
}
