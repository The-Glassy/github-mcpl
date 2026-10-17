/**
 * Contributor mode's notifications poller (anima-research/github-mcpl#5).
 *
 * `NotificationsPollerApi` is faked in memory here rather than over a real
 * `node:http` server: the HTTP-protocol parts of this ingress — the 304
 * short-circuit, reading `Last-Modified`/`X-Poll-Interval` off real response
 * headers — are exercised against a real `GitHubAdapter` and a fake GitHub in
 * githubAdapter.test.ts ("Contributor mode" section); what is left to prove
 * here is the poller's own logic: which rows become which events, the dedup
 * ring, and the floor/roof an `X-Poll-Interval` can and cannot move.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  NotificationsPoller,
  type NotificationsIngressState,
  type NotificationsPollerApi,
} from '../src/notifications-poller.js';
import { GithubState } from '../src/state.js';
import {
  channelId,
  MIN_POLL_INTERVAL_MS,
  type Comment,
  type EventActor,
  type Issue,
  type NormalizedEvent,
  type PolledComment,
  type PolledReview,
  type PullRequest,
  type RepoRef,
  type ThreadRef,
} from '../src/types.js';
import type { NotificationRow, NotificationsPage } from '../src/github-adapter.js';

const REPO: RepoRef = { owner: 'anima-research', name: 'rayforce' };
const ISSUE: ThreadRef = { repo: REPO, number: 7, kind: 'issue' };
const PULL: ThreadRef = { repo: REPO, number: 12, kind: 'pull' };
const HUMAN: EventActor = { login: 'human-one', isBot: false };

function issue(partial: Partial<Issue> = {}): Issue {
  return {
    number: ISSUE.number,
    kind: 'issue',
    repo: REPO,
    title: 'A bug',
    body: 'it breaks',
    state: 'open',
    stateReason: null,
    author: HUMAN,
    labels: [],
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    html_url: 'https://github.com/anima-research/rayforce/issues/7',
    ...partial,
  };
}

function pull(partial: Partial<PullRequest> = {}): PullRequest {
  return {
    number: PULL.number,
    kind: 'pull',
    repo: REPO,
    title: 'Fix it',
    body: 'the fix',
    state: 'open',
    draft: false,
    merged: false,
    mergeable: true,
    head: { ref: 'fix', sha: 'head-sha-1' },
    base: { ref: 'main', sha: 'base-sha' },
    author: HUMAN,
    requestedReviewers: [],
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
    html_url: 'https://github.com/anima-research/rayforce/pull/12',
    checksSummary: null,
    ...partial,
  };
}

function notification(thread: ThreadRef, id: string, overrides: Partial<NotificationRow> = {}): NotificationRow {
  return {
    id,
    updatedAt: '2026-10-15T00:00:00Z',
    reason: 'participating',
    unread: true,
    repo: thread.repo,
    kind: thread.kind,
    number: thread.number,
    title: 'something happened',
    ...overrides,
  };
}

/** In-memory `NotificationsPollerApi`. `since` filtering matches the real adapter's: inclusive for comments, strict for reviews. */
class FakeNotificationsApi implements NotificationsPollerApi {
  readonly pages: NotificationsPage[] = [];
  readonly calls: string[] = [];
  readonly markedRead: string[] = [];
  readonly comments = new Map<string, Comment[]>();
  readonly reviewComments = new Map<string, PolledComment[]>();
  readonly reviews = new Map<string, PolledReview[]>();
  readonly issues = new Map<number, Issue>();
  readonly pulls = new Map<number, PullRequest>();

  queuePage(page: NotificationsPage): void {
    this.pages.push(page);
  }

  async listNotifications(ifModifiedSince: string | null): Promise<NotificationsPage> {
    this.calls.push(`listNotifications(${ifModifiedSince})`);
    return (
      this.pages.shift() ?? { notifications: [], notModified: true, lastModified: ifModifiedSince, pollIntervalSeconds: null }
    );
  }

  async listComments(thread: ThreadRef, since?: string): Promise<Comment[]> {
    const rows = this.comments.get(channelId(thread)) ?? [];
    if (!since) return rows;
    return rows.filter((row) => Date.parse(row.updatedAt) >= Date.parse(since));
  }

  async listReviewCommentsSince(repo: RepoRef, since: string): Promise<PolledComment[]> {
    const rows = this.reviewComments.get(`${repo.owner}/${repo.name}`) ?? [];
    return rows.filter((row) => Date.parse(row.updatedAt) >= Date.parse(since));
  }

  async listReviewsSince(thread: ThreadRef, since: string): Promise<PolledReview[]> {
    const rows = this.reviews.get(channelId(thread)) ?? [];
    return rows.filter((row) => Date.parse(row.submittedAt) > Date.parse(since));
  }

  async getIssue(ref: ThreadRef): Promise<Issue> {
    const found = this.issues.get(ref.number);
    if (!found) throw new Error(`no issue seeded for #${ref.number}`);
    return found;
  }

  async getPullRequest(ref: ThreadRef): Promise<PullRequest> {
    const found = this.pulls.get(ref.number);
    if (!found) throw new Error(`no pull seeded for #${ref.number}`);
    return found;
  }

  async markNotificationThreadRead(threadId: string): Promise<void> {
    this.markedRead.push(threadId);
  }
}

/** `NotificationsIngressState` over `GithubState`, so "stable across restarts" can be tested by reloading from a file. */
function stateOver(file: string | null = null): GithubState & NotificationsIngressState {
  return GithubState.load(file);
}

interface Rig {
  api: FakeNotificationsApi;
  state: GithubState;
  poller: NotificationsPoller;
  events: NormalizedEvent[];
}

/**
 * `now` defaults to just after every fixture's timestamp: a never-before-seen
 * thread bootstraps its cursor at `now - intervalMs`, and a test fixture's
 * `2026-10-15T00:00:00Z` rows must sort after that bootstrap or the poller
 * (correctly) treats them as older than its own window.
 */
function rig(options: { stateFile?: string | null; intervalMs?: number; now?: string } = {}): Rig {
  const api = new FakeNotificationsApi();
  const state = stateOver(options.stateFile ?? null);
  const events: NormalizedEvent[] = [];
  const now = Date.parse(options.now ?? '2026-10-15T00:00:30.000Z');
  const poller = new NotificationsPoller({
    api,
    state,
    intervalMs: options.intervalMs ?? MIN_POLL_INTERVAL_MS,
    onEvent: (event) => {
      events.push(event);
    },
    now: () => new Date(now),
  });
  return { api, state, poller, events };
}

// ─────────────────────────────────────────────────────────────────────────────
// The 304 path
// ─────────────────────────────────────────────────────────────────────────────

test('a 304 costs nothing: no thread is read, nothing is delivered', async () => {
  const r = rig();
  r.api.queuePage({ notifications: [], notModified: true, lastModified: 'Wed, 15 Oct 2026 00:05:00 GMT', pollIntervalSeconds: null });
  const result = await r.poller.pollOnce();
  assert.equal(result.notModified, true);
  assert.deepEqual(result.delivered, []);
  assert.equal(r.events.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// One new comment, one event
// ─────────────────────────────────────────────────────────────────────────────

test('a new issue comment on a notified thread becomes exactly one comment.created event', async () => {
  const r = rig();
  r.api.issues.set(ISSUE.number, issue());
  r.api.comments.set(channelId(ISSUE), [
    { id: 555, author: HUMAN, body: 'any news?', createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', html_url: 'https://x/555' },
  ]);
  r.api.queuePage({
    notifications: [notification(ISSUE, 'n1')],
    notModified: false,
    lastModified: 'Wed, 15 Oct 2026 00:05:00 GMT',
    pollIntervalSeconds: null,
  });

  const result = await r.poller.pollOnce();
  assert.equal(result.threads, 1);
  assert.equal(result.delivered.length, 1);
  assert.equal(result.delivered[0].kind, 'comment.created');
  assert.equal(result.delivered[0].comment?.id, 555);
  assert.equal(result.delivered[0].thread?.number, ISSUE.number);
  assert.equal(r.state.lastPollAt(), 'Wed, 15 Oct 2026 00:05:00 GMT');
});

// ─────────────────────────────────────────────────────────────────────────────
// One submitted review, one event
// ─────────────────────────────────────────────────────────────────────────────

test('a submitted review on a notified pull request becomes exactly one review.submitted event', async () => {
  const r = rig();
  r.api.pulls.set(PULL.number, pull());
  r.api.reviews.set(channelId(PULL), [
    { id: 909, author: HUMAN, body: 'looks good', state: 'approved', submittedAt: '2026-10-15T00:00:00Z', html_url: 'https://x/909' },
  ]);
  r.api.queuePage({ notifications: [notification(PULL, 'n2')], notModified: false, lastModified: null, pollIntervalSeconds: null });

  const result = await r.poller.pollOnce();
  assert.equal(result.delivered.length, 1);
  assert.equal(result.delivered[0].kind, 'review.submitted');
  assert.deepEqual(result.delivered[0].review, { id: 909, state: 'approved' });
  assert.equal(result.delivered[0].thread?.kind, 'pull');
});

// ─────────────────────────────────────────────────────────────────────────────
// Dedup, including across a restart
// ─────────────────────────────────────────────────────────────────────────────

test('the same comment reported twice by the notifications endpoint is delivered once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'github-mcpl-notif-'));
  const file = join(dir, 'state.json');

  // `now` for the first pass: the comment's own `updatedAt` matches it
  // exactly, so after the pass advances the per-thread cursor to this same
  // instant, GitHub's inclusive `since` could legitimately return this exact
  // row again — which is exactly the case the dedup ring, not the cursor, has
  // to catch.
  const firstPassNow = '2026-10-15T00:00:30.000Z';
  const r = rig({ stateFile: file, now: firstPassNow });
  r.api.issues.set(ISSUE.number, issue());
  const comment: Comment = {
    id: 555,
    author: HUMAN,
    body: 'any news?',
    createdAt: '2026-10-15T00:00:00Z',
    updatedAt: firstPassNow,
    html_url: 'https://x/555',
  };
  r.api.comments.set(channelId(ISSUE), [comment]);
  r.api.queuePage({ notifications: [notification(ISSUE, 'n1')], notModified: false, lastModified: null, pollIntervalSeconds: null });

  const first = await r.poller.pollOnce();
  assert.equal(first.delivered.length, 1);
  await r.state.flush();

  // A fresh poller and a fresh state, loaded from the file a restart would
  // read back — the dedup key has to be recognised with no in-memory help.
  const reloadedState = stateOver(file);
  const reloadedEvents: NormalizedEvent[] = [];
  const reloadedApi = new FakeNotificationsApi();
  reloadedApi.issues.set(ISSUE.number, issue());
  // The endpoint reports the same comment again (GitHub's `since` is
  // inclusive, and the notification itself can repeat while a thread stays
  // "unread, participating").
  reloadedApi.comments.set(channelId(ISSUE), [comment]);
  reloadedApi.queuePage({ notifications: [notification(ISSUE, 'n1')], notModified: false, lastModified: null, pollIntervalSeconds: null });
  const reloadedPoller = new NotificationsPoller({
    api: reloadedApi,
    state: reloadedState,
    intervalMs: MIN_POLL_INTERVAL_MS,
    onEvent: (event) => {
      reloadedEvents.push(event);
    },
    now: () => new Date('2026-10-15T00:01:00.000Z'),
  });

  const second = await reloadedPoller.pollOnce();
  assert.equal(second.delivered.length, 0, 'the restarted poller recognised the key from the persisted ring');
  assert.equal(second.duplicates, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// X-Poll-Interval
// ─────────────────────────────────────────────────────────────────────────────

test('X-Poll-Interval is honoured, but never below GITHUB_POLL_INTERVAL_MS or the 60s floor', async () => {
  const r = rig({ intervalMs: MIN_POLL_INTERVAL_MS });
  assert.equal(r.poller.effectiveIntervalMs, MIN_POLL_INTERVAL_MS);

  r.api.queuePage({ notifications: [], notModified: true, lastModified: null, pollIntervalSeconds: 120 });
  await r.poller.pollOnce();
  assert.equal(r.poller.effectiveIntervalMs, 120_000, 'a longer server interval raises it above the floor');

  // A server interval shorter than GITHUB_POLL_INTERVAL_MS/the floor cannot
  // push the effective interval below either — it is a floor, not a target.
  r.api.queuePage({ notifications: [], notModified: true, lastModified: null, pollIntervalSeconds: 10 });
  await r.poller.pollOnce();
  assert.equal(r.poller.effectiveIntervalMs, MIN_POLL_INTERVAL_MS, 'the configured floor still wins over a 10s header');
});

// ─────────────────────────────────────────────────────────────────────────────
// A thread whose fetch fails holds the whole pass's cursor back
// ─────────────────────────────────────────────────────────────────────────────

test('a thread whose own fetch fails is retried next pass, without losing other threads delivered this pass', async () => {
  const r = rig();
  r.api.issues.set(ISSUE.number, issue());
  r.api.comments.set(channelId(ISSUE), [
    { id: 1, author: HUMAN, body: 'hi', createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', html_url: 'https://x/1' },
  ]);
  // Pull 12 has no seeded data at all: `getPullRequest` throws.
  r.api.queuePage({
    notifications: [notification(ISSUE, 'n1'), notification(PULL, 'n2')],
    notModified: false,
    lastModified: 'Wed, 15 Oct 2026 00:05:00 GMT',
    pollIntervalSeconds: null,
  });

  const result = await r.poller.pollOnce();
  assert.equal(result.delivered.length, 1, 'the issue thread still delivered');
  assert.equal(result.failed, 1, 'the pull thread is reported as failed');
  assert.equal(r.state.lastPollAt(), null, 'Last-Modified is held back while a thread failed');
});
