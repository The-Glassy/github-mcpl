/**
 * Contributor mode's owned-repository poll (GITHUB_OWNED_REPO_POLL).
 *
 * The notifications poller lists only the threads the token's user takes
 * part in, so an issue someone else opened in the user's own repository never
 * arrived (The-Glassy/bosun-browser#9). This file proves the fix: the config
 * switch, the repository poll's `arrivals` scope (openings, reopens and new
 * comments by others, nothing else), which repositories get polled and when
 * that is asked again, and that running it inside the notifications pass
 * delivers a row both paths see once.
 */

import { strict as assert } from 'node:assert';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { NotificationsPoller, type NotificationsPollerApi } from '../src/notifications-poller.js';
import { OWNED_REPO_RECHECK_MS, OwnedRepoPoll, type OwnedRepoApi } from '../src/owned-repos.js';
import { Poller } from '../src/poller.js';
import { GithubState } from '../src/state.js';
import { GitHubApiError, type NotificationRow, type NotificationsPage, type OwnPull } from '../src/github-adapter.js';
import {
  ConfigError,
  MIN_POLL_INTERVAL_MS,
  channelId,
  readConfig,
  repoSlug,
  type ChecksSummary,
  type EventActor,
  type Env,
  type NormalizedEvent,
  type PolledComment,
  type PolledIssue,
  type PolledReview,
  type RepoRef,
  type ThreadRef,
} from '../src/types.js';

const OWNED: RepoRef = { owner: 'The-Glassy', name: 'bosun-browser' };
const UPSTREAM: RepoRef = { owner: 'anima-research', name: 'github-mcpl' };
const SELF: EventActor = { login: 'The-Glassy', isBot: false };
const OTHER: EventActor = { login: 'theaspirational', isBot: false };

/** Every pass runs at this instant unless a test moves it; a first pass reads from one interval before. */
const START = '2026-10-22T10:00:00.000Z';
const BEFORE_START = '2026-10-21T00:00:00Z';

function issueRow(number: number, partial: Partial<PolledIssue> = {}): PolledIssue {
  return {
    id: number * 1000,
    number,
    isPullRequest: false,
    title: `Issue ${number}`,
    body: 'text',
    state: 'open',
    author: OTHER,
    createdAt: '2026-10-22T09:59:30Z',
    updatedAt: '2026-10-22T09:59:30Z',
    html_url: `https://github.com/${OWNED.owner}/${OWNED.name}/issues/${number}`,
    ...partial,
  };
}

function pullRow(number: number, partial: Partial<PolledIssue> = {}): PolledIssue {
  return issueRow(number, {
    isPullRequest: true,
    headSha: `head${number}`.padEnd(40, '0'),
    html_url: `https://github.com/${OWNED.owner}/${OWNED.name}/pull/${number}`,
    ...partial,
  });
}

function commentRow(id: number, number: number, partial: Partial<PolledComment> = {}): PolledComment {
  return {
    id,
    number,
    author: OTHER,
    body: `comment ${id}`,
    createdAt: '2026-10-22T09:59:40Z',
    updatedAt: '2026-10-22T09:59:40Z',
    html_url: `https://github.com/${OWNED.owner}/${OWNED.name}/issues/${number}#issuecomment-${id}`,
    ...partial,
  };
}

/**
 * GitHub as both pollers read it: each repository's issue and comment rows,
 * which the repository poll lists by `since` and the notifications poller
 * reads thread by thread, an inbox of participating threads, and each
 * repository's permissions.
 */
class FakeGitHub implements OwnedRepoApi, NotificationsPollerApi {
  readonly issues = new Map<string, PolledIssue[]>();
  readonly comments = new Map<string, PolledComment[]>();
  readonly administered = new Map<string, boolean | Error>();
  inbox: NotificationRow[] = [];
  readonly calls: string[] = [];

  setIssue(repo: RepoRef, row: PolledIssue): void {
    const rows = (this.issues.get(repoSlug(repo)) ?? []).filter((r) => r.number !== row.number);
    this.issues.set(repoSlug(repo), [...rows, row]);
  }

  addComment(repo: RepoRef, row: PolledComment): void {
    const rows = (this.comments.get(repoSlug(repo)) ?? []).filter((c) => c.id !== row.id);
    this.comments.set(repoSlug(repo), [...rows, row]);
  }

  // ── The repository poll ──

  async repoAdministered(repo: RepoRef): Promise<boolean> {
    this.calls.push(`permissions ${repoSlug(repo)}`);
    const answer = this.administered.get(repoSlug(repo)) ?? false;
    if (answer instanceof Error) throw answer;
    return answer;
  }

  async listIssuesSince(repo: RepoRef, since: string): Promise<PolledIssue[]> {
    this.calls.push(`issues ${repoSlug(repo)} since=${since}`);
    return (this.issues.get(repoSlug(repo)) ?? []).filter((r) => Date.parse(r.updatedAt) >= Date.parse(since));
  }

  async listIssueCommentsSince(repo: RepoRef, since: string): Promise<PolledComment[]> {
    this.calls.push(`repo comments ${repoSlug(repo)} since=${since}`);
    return (this.comments.get(repoSlug(repo)) ?? []).filter((c) => Date.parse(c.updatedAt) >= Date.parse(since));
  }

  async listReviewCommentsSince(repo: RepoRef): Promise<PolledComment[]> {
    this.calls.push(`repo review comments ${repoSlug(repo)}`);
    return [];
  }

  async getCheckRuns(_repo: RepoRef, sha: string): Promise<ChecksSummary> {
    this.calls.push(`checks ${sha}`);
    return { sha, conclusion: null, total: 0, failed: [] };
  }

  // ── The notifications poller ──

  async listNotifications(opts: { since: string; ifModifiedSince: string | null }): Promise<NotificationsPage> {
    this.calls.push('list notifications');
    const notifications = this.inbox.filter((n) => Date.parse(n.updatedAt) > Date.parse(opts.since));
    return { notifications, notModified: false, lastModified: null, date: null, pollIntervalSeconds: null, truncated: false };
  }

  async getPolledThread(thread: ThreadRef): Promise<PolledIssue> {
    const row = (this.issues.get(repoSlug(thread.repo)) ?? []).find((r) => r.number === thread.number);
    if (!row) throw new Error(`no thread seeded for ${channelId(thread)}`);
    return row;
  }

  async listCommentsSince(thread: ThreadRef, since: string): Promise<PolledComment[]> {
    return (this.comments.get(repoSlug(thread.repo)) ?? []).filter(
      (c) => c.number === thread.number && Date.parse(c.updatedAt) >= Date.parse(since),
    );
  }

  async listPullReviewCommentsSince(): Promise<PolledComment[]> {
    return [];
  }

  async listReviewsSince(): Promise<PolledReview[]> {
    return [];
  }

  async listOwnOpenPulls(): Promise<OwnPull[]> {
    return [];
  }

  async getPullHeadSha(pull: ThreadRef): Promise<string> {
    throw new Error(`no head for ${channelId(pull)}`);
  }
}

interface Rig {
  github: FakeGitHub;
  state: GithubState;
  owned: OwnedRepoPoll;
  events: NormalizedEvent[];
  logs: string[];
  setNow(at: string): void;
}

function rig(options: { repos?: RepoRef[]; github?: FakeGitHub; state?: GithubState } = {}): Rig {
  const github = options.github ?? new FakeGitHub();
  if (options.github === undefined) github.administered.set(repoSlug(OWNED), true);
  const state = options.state ?? GithubState.load(null);
  const events: NormalizedEvent[] = [];
  const logs: string[] = [];
  const record = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    logs.push(`${level} ${message} ${fields ? JSON.stringify(fields) : ''}`);
  };
  let now = Date.parse(START);
  const owned = new OwnedRepoPoll({
    api: github,
    repos: options.repos ?? [OWNED],
    login: SELF.login,
    state,
    intervalMs: MIN_POLL_INTERVAL_MS,
    onEvent: (event) => {
      events.push(event);
    },
    now: () => new Date(now),
    logger: { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') },
  });
  return { github, state, owned, events, logs, setNow: (at) => { now = Date.parse(at); } };
}

const kinds = (events: NormalizedEvent[]): string[] => events.map((e) => `${e.kind} #${e.thread?.number}`);

// ─────────────────────────────────────────────────────────────────────────────
// The switch

function tokenFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'github-mcpl-owned-'));
  const file = join(dir, 'token');
  writeFileSync(file, 'ghp_fake_token_for_tests\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

function problemsOf(env: Env): string[] {
  try {
    readConfig(env);
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.problems;
  }
  assert.fail('expected a ConfigError');
}

test('GITHUB_OWNED_REPO_POLL is auto by default in contributor mode, and off turns it off', () => {
  const base = { GITHUB_TOKEN_FILE: tokenFile(), GITHUB_REPOS: repoSlug(OWNED) };
  assert.equal(readConfig(base).ownedRepoPoll, 'auto');
  assert.equal(readConfig({ ...base, GITHUB_OWNED_REPO_POLL: 'auto' }).ownedRepoPoll, 'auto');
  assert.equal(readConfig({ ...base, GITHUB_OWNED_REPO_POLL: ' OFF ' }).ownedRepoPoll, 'off');
  assert.deepEqual(problemsOf({ ...base, GITHUB_OWNED_REPO_POLL: 'yes' }), ['GITHUB_OWNED_REPO_POLL: must be "auto" or "off", got "yes"']);
});

test('GITHUB_OWNED_REPO_POLL is off in App mode, and asking App mode for auto is refused', () => {
  const keyDir = mkdtempSync(join(tmpdir(), 'github-mcpl-owned-'));
  const keyFile = join(keyDir, 'key.pem');
  writeFileSync(keyFile, 'not a key', { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  const app = { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY_FILE: keyFile, GITHUB_REPOS: repoSlug(OWNED), GITHUB_BOT_LOGIN: 'x[bot]' };
  assert.equal(readConfig(app).ownedRepoPoll, 'off');
  assert.equal(readConfig({ ...app, GITHUB_OWNED_REPO_POLL: 'off' }).ownedRepoPoll, 'off');
  assert.ok(problemsOf({ ...app, GITHUB_OWNED_REPO_POLL: 'auto' })[0]?.startsWith('GITHUB_OWNED_REPO_POLL: contributor mode only'));
});

// ─────────────────────────────────────────────────────────────────────────────
// The arrivals scope

test('an issue or pull request someone else opened arrives as opened; the user\'s own does not', async () => {
  const r = rig();
  r.github.setIssue(OWNED, issueRow(9));
  r.github.setIssue(OWNED, pullRow(10, { createdAt: '2026-10-22T09:59:35Z', updatedAt: '2026-10-22T09:59:35Z' }));
  r.github.setIssue(OWNED, issueRow(11, { author: SELF }));
  const result = await r.owned.pollOnce();
  assert.deepEqual(kinds(r.events), ['issue.opened #9', 'pull.opened #10']);
  assert.equal(r.events[0]?.actor?.login, OTHER.login);
  assert.equal(r.events[0]?.id, `poll:issue:9000:2026-10-22T09:59:30Z`);
  assert.equal(result.cursorAdvanced, true);
  assert.equal(r.state.lastPollAt(), START);
});

test('a new comment by someone else arrives; the user\'s own, an edit, and review comments do not', async () => {
  const r = rig();
  r.github.setIssue(OWNED, issueRow(9, { createdAt: BEFORE_START, updatedAt: '2026-10-22T09:59:50Z' }));
  r.github.addComment(OWNED, commentRow(1, 9));
  r.github.addComment(OWNED, commentRow(2, 9, { author: SELF }));
  // Posted yesterday, edited now: its `updated_at` is in the window, its post isn't.
  r.github.addComment(OWNED, commentRow(3, 9, { createdAt: BEFORE_START }));
  await r.owned.pollOnce();
  assert.deepEqual(kinds(r.events), ['comment.created #9']);
  assert.equal(r.events[0]?.comment?.id, 1);
  assert.ok(!r.github.calls.some((c) => c.startsWith('repo review comments')), 'the arrivals scope reads no review comments');
  assert.ok(!r.github.calls.some((c) => c.startsWith('checks')), 'and looks up no checks');
});

test('an edit and a close are left out, and the close is remembered, so a later reopen arrives as reopened', async () => {
  const r = rig();
  r.github.setIssue(OWNED, issueRow(9, { createdAt: BEFORE_START, title: 'edited', updatedAt: '2026-10-22T09:59:50Z' }));
  await r.owned.pollOnce();
  assert.deepEqual(r.events, []);

  r.setNow('2026-10-22T10:01:00.000Z');
  r.github.setIssue(OWNED, issueRow(9, { createdAt: BEFORE_START, state: 'closed', updatedAt: '2026-10-22T10:00:30Z' }));
  await r.owned.pollOnce();
  assert.deepEqual(r.events, []);
  assert.match(r.state.polledHead(channelId({ repo: OWNED, number: 9, kind: 'issue' })) ?? '', /^issue:closed:/);

  r.setNow('2026-10-22T10:02:00.000Z');
  r.github.setIssue(OWNED, issueRow(9, { createdAt: BEFORE_START, state: 'open', updatedAt: '2026-10-22T10:01:30Z' }));
  await r.owned.pollOnce();
  assert.deepEqual(kinds(r.events), ['issue.reopened #9']);

  // A comment bumps the reopened issue: not reopened again.
  r.setNow('2026-10-22T10:03:00.000Z');
  r.github.setIssue(OWNED, issueRow(9, { createdAt: BEFORE_START, state: 'open', updatedAt: '2026-10-22T10:02:30Z' }));
  await r.owned.pollOnce();
  assert.deepEqual(kinds(r.events), ['issue.reopened #9']);
});

test('a reopened pull request arrives as pull.opened, the vocabulary having no reopen for one', async () => {
  const r = rig();
  r.github.setIssue(OWNED, pullRow(10, { createdAt: BEFORE_START, state: 'closed', headSha: undefined }));
  await r.owned.pollOnce();
  assert.deepEqual(r.events, []);
  r.setNow('2026-10-22T10:01:00.000Z');
  r.github.setIssue(OWNED, pullRow(10, { createdAt: BEFORE_START, updatedAt: '2026-10-22T10:00:30Z' }));
  await r.owned.pollOnce();
  assert.deepEqual(kinds(r.events), ['pull.opened #10']);
});

test('the arrivals scope records no marker for an open thread it leaves out', async () => {
  const r = rig();
  r.github.setIssue(OWNED, issueRow(9, { createdAt: BEFORE_START, title: 'edited' }));
  r.github.setIssue(OWNED, pullRow(10, { createdAt: BEFORE_START }));
  await r.owned.pollOnce();
  assert.equal(r.state.polledHead(channelId({ repo: OWNED, number: 9, kind: 'issue' })), null);
  assert.equal(r.state.polledHead(channelId({ repo: OWNED, number: 10, kind: 'pull' })), null);
});

test('App mode\'s scope is unchanged: the same rows bring the edit, the comments and the check lookup', async () => {
  const github = new FakeGitHub();
  github.setIssue(OWNED, pullRow(10, { createdAt: BEFORE_START }));
  github.addComment(OWNED, commentRow(2, 10, { author: SELF }));
  const events: NormalizedEvent[] = [];
  const poller = new Poller({
    api: github,
    repos: [OWNED],
    state: GithubState.load(null),
    intervalMs: MIN_POLL_INTERVAL_MS,
    onEvent: (e) => {
      events.push(e);
    },
    now: () => new Date(START),
  });
  await poller.pollOnce();
  assert.deepEqual(kinds(events), ['pull.synchronize #10', 'comment.created #10']);
  assert.ok(github.calls.some((c) => c.startsWith('repo review comments')));
  assert.ok(github.calls.some((c) => c.startsWith('checks')));
});

// ─────────────────────────────────────────────────────────────────────────────
// Which repositories

test('only the repositories the user administers or maintains are polled, asked once and again after an hour', async () => {
  const github = new FakeGitHub();
  github.administered.set(repoSlug(OWNED), true);
  github.administered.set(repoSlug(UPSTREAM), false);
  const r = rig({ github, repos: [OWNED, UPSTREAM] });
  await r.owned.pollOnce();
  assert.deepEqual(r.owned.polled, [OWNED]);
  assert.ok(r.github.calls.includes(`issues ${repoSlug(OWNED)} since=2026-10-22T09:59:00.000Z`));
  assert.ok(!r.github.calls.some((c) => c.startsWith(`issues ${repoSlug(UPSTREAM)}`)));
  assert.ok(r.logs.some((l) => l.startsWith('info owned-repo poll: repositories') && l.includes('["The-Glassy/bosun-browser"]')));

  // Within the hour: not asked again, whatever changed on GitHub.
  github.administered.set(repoSlug(UPSTREAM), true);
  r.setNow('2026-10-22T10:30:00.000Z');
  await r.owned.pollOnce();
  assert.equal(r.github.calls.filter((c) => c.startsWith('permissions')).length, 2);
  assert.deepEqual(r.owned.polled, [OWNED]);

  r.setNow(new Date(Date.parse(START) + OWNED_REPO_RECHECK_MS).toISOString());
  await r.owned.pollOnce();
  assert.equal(r.github.calls.filter((c) => c.startsWith('permissions')).length, 4);
  assert.deepEqual(r.owned.polled, [OWNED, UPSTREAM]);
  assert.equal(r.logs.filter((l) => l.startsWith('info owned-repo poll: repositories')).length, 2, 'a change is logged once');
});

test('a failed permissions read keeps the last answer, and a repository never answered for is not polled until it is', async () => {
  const github = new FakeGitHub();
  github.administered.set(repoSlug(OWNED), new GitHubApiError(502, 'Bad Gateway', 'getRepository'));
  const r = rig({ github });
  await r.owned.pollOnce();
  assert.deepEqual(r.owned.polled, []);
  assert.ok(r.logs.some((l) => l.startsWith('warn owned-repo poll: reading a repository\'s permissions failed')));
  // The cursor keeps up while nothing is polled.
  assert.equal(r.state.lastPollAt(), START);

  github.administered.set(repoSlug(OWNED), true);
  r.setNow('2026-10-22T10:01:00.000Z');
  await r.owned.pollOnce();
  assert.deepEqual(r.owned.polled, [OWNED]);

  github.administered.set(repoSlug(OWNED), new GitHubApiError(502, 'Bad Gateway', 'getRepository'));
  r.setNow(new Date(Date.parse('2026-10-22T10:01:00.000Z') + OWNED_REPO_RECHECK_MS).toISOString());
  await r.owned.pollOnce();
  assert.deepEqual(r.owned.polled, [OWNED]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Beside the notifications poller

function notificationsRig(github: FakeGitHub, options: { owned?: boolean } = {}) {
  const state = GithubState.load(null);
  const events: NormalizedEvent[] = [];
  const logs: string[] = [];
  const record = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    logs.push(`${level} ${message} ${fields ? JSON.stringify(fields) : ''}`);
  };
  const logger = { debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
  let now = Date.parse(START);
  const onEvent = (event: NormalizedEvent): void => {
    events.push(event);
  };
  const ownedRepos =
    options.owned === false
      ? undefined
      : new OwnedRepoPoll({ api: github, repos: [OWNED], login: SELF.login, state, intervalMs: MIN_POLL_INTERVAL_MS, onEvent, logger, now: () => new Date(now) });
  const poller = new NotificationsPoller({
    api: github,
    state,
    intervalMs: MIN_POLL_INTERVAL_MS,
    repos: [OWNED],
    login: SELF.login,
    ...(ownedRepos ? { ownedRepos } : {}),
    onEvent,
    logger,
    now: () => new Date(now),
  });
  poller.start();
  poller.stop();
  return { state, events, logs, poller, setNow: (at: string) => { now = Date.parse(at); } };
}

function notify(github: FakeGitHub, number: number, updatedAt: string): void {
  github.inbox = [
    ...github.inbox.filter((n) => n.number !== number),
    { id: `n-${number}`, updatedAt, reason: 'mention', unread: true, repo: OWNED, kind: 'issue', number, title: 't' },
  ];
}

test('without the owned-repository poll, an issue someone else opened in an owned repository never arrives (bosun-browser#9)', async () => {
  const github = new FakeGitHub();
  github.administered.set(repoSlug(OWNED), true);
  github.setIssue(OWNED, issueRow(9));
  const r = notificationsRig(github, { owned: false });
  await r.poller.pollOnce();
  assert.deepEqual(r.events, []);
});

test('with it, the notifications pass delivers the opening, and a row both paths read is delivered once', async () => {
  const github = new FakeGitHub();
  github.administered.set(repoSlug(OWNED), true);
  github.setIssue(OWNED, issueRow(9, { updatedAt: '2026-10-22T09:59:45Z' }));
  github.addComment(OWNED, commentRow(1, 9, { body: '@The-Glassy look', createdAt: '2026-10-22T09:59:45Z', updatedAt: '2026-10-22T09:59:45Z' }));
  // The mention makes it a participating thread: the notifications poller reads it too.
  notify(github, 9, '2026-10-22T09:59:46Z');
  const r = notificationsRig(github);
  const result = await r.poller.pollOnce();
  assert.deepEqual(kinds(r.events), ['comment.created #9', 'issue.opened #9']);
  assert.equal(result.delivered.length, 2);
  assert.equal(result.duplicates, 2, 'the owned-repository pass found both already delivered');

  // Next pass: the thread is listed and read again, and nothing comes twice.
  r.setNow('2026-10-22T10:01:00.000Z');
  notify(github, 9, '2026-10-22T10:00:30Z');
  await r.poller.pollOnce();
  assert.deepEqual(kinds(r.events), ['comment.created #9', 'issue.opened #9']);
});

test('the owned-repository pass runs after the notifications pass, and its failure fails nothing else', async () => {
  const github = new FakeGitHub();
  github.administered.set(repoSlug(OWNED), true);
  github.listIssuesSince = async () => {
    throw new GitHubApiError(502, 'Bad Gateway', 'listIssuesSince');
  };
  const r = notificationsRig(github);
  const result = await r.poller.pollOnce();
  assert.equal(result.failed, 0);
  assert.ok(r.logs.some((l) => l.startsWith('warn owned-repo poll: the pass failed')));
  assert.equal(r.state.lastPollAt(), null, 'its cursor stays');
  assert.ok(github.calls.indexOf('list notifications') < github.calls.indexOf(`permissions ${repoSlug(OWNED)}`));
});
