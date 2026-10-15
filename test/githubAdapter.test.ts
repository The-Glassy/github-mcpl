/**
 * GitHubAdapter against a local fake GitHub (TASK-SRHKG.1.2).
 *
 * Nothing here leaves the process: the adapter is pointed at a `node:http`
 * server on 127.0.0.1 that answers the endpoints the contract names, and the
 * real octokit transport runs against it. So the paths, query strings, bodies
 * and headers asserted below are the ones that would go to github.com.
 *
 * The App key is a throwaway RSA pair generated here and written to a mode-600
 * temp file; no PEM is committed and no real key is read. The installation
 * token is a sentinel string, which lets every test assert the same thing: it
 * reaches the `authorization` header and nowhere else — not a log line, not an
 * error, not a stack.
 */

import { strict as assert } from 'node:assert';
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  GitHubAdapter,
  GitHubApiError,
  POLL_MAX_ENTRIES,
  POLL_PR_HEAD_LIMIT,
  REDACTED,
  redactSecrets,
  summarizeChecks,
} from '../src/github-adapter.js';
import {
  GITHUB_API_METHODS,
  readConfig,
  type Config,
  type Logger,
  type RepoRef,
  type ThreadRef,
} from '../src/types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const REPO: RepoRef = { owner: 'anima-research', name: 'rayforce' };
const ISSUE: ThreadRef = { repo: REPO, number: 7, kind: 'issue' };
const PULL: ThreadRef = { repo: REPO, number: 12, kind: 'pull' };
const HEAD_SHA = 'f00dcafe00000000000000000000000000000000';

/** The sentinel no log line, error or stack may ever contain. */
const TOKEN = 'ghs_TESTINSTALLATIONTOKEN_do_not_log';
const APP_ID = '123456';
const INSTALLATION_ID = 42;

/** One throwaway key for the whole file; generating RSA is not free. */
const KEY_PAIR = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const KEY_FILE = join(mkdtempSync(join(tmpdir(), 'github-mcpl-key-')), 'app.pem');
writeFileSync(KEY_FILE, KEY_PAIR.privateKey, { mode: 0o600 });

function config(extra: Record<string, string | undefined> = {}): Config {
  return readConfig({
    GITHUB_APP_ID: APP_ID,
    GITHUB_APP_PRIVATE_KEY_FILE: KEY_FILE,
    GITHUB_APP_INSTALLATION_ID: String(INSTALLATION_ID),
    GITHUB_REPOS: 'anima-research/rayforce',
    GITHUB_BOT_LOGIN: 'rayforce-clone[bot]',
    GITHUB_PR_BASE_ALLOW: 'dev',
    ...extra,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The fake GitHub
// ─────────────────────────────────────────────────────────────────────────────

interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface Answer {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

/** A handler may return a promise, which holds the request in flight. */
type Handler = (req: Recorded, nth: number) => Answer | Promise<Answer>;

class FakeGitHub {
  readonly calls: Recorded[] = [];
  private readonly routes = new Map<string, { handler: Handler; count: number }>();
  private server!: Server;
  baseUrl = '';

  /** `on('GET /repos/o/r/issues/7', …)`. A later `on` replaces an earlier one. */
  on(route: string, answer: Answer | Handler): this {
    const handler: Handler = typeof answer === 'function' ? answer : () => answer;
    this.routes.set(route, { handler, count: 0 });
    return this;
  }

  /** Requests recorded for one route, in order. */
  for(route: string): Recorded[] {
    const [method, path] = route.split(' ');
    return this.calls.filter((c) => c.method === method && c.path === path);
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
        const url = new URL(req.url ?? '/', 'http://fake');
        const raw = Buffer.concat(chunks).toString('utf8');
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') headers[k] = v;
        }
        const recorded: Recorded = {
          method: req.method ?? 'GET',
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          headers,
          body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
        };
        this.calls.push(recorded);

        const entry = this.routes.get(`${recorded.method} ${recorded.path}`);
        const answer: Answer = entry
          ? await entry.handler(recorded, entry.count++)
          : { status: 404, body: { message: 'Not Found' } };

        const status = answer.status ?? 200;
        const out = {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
          ...(answer.headers ?? {}),
        };
        res.writeHead(status, out);
        res.end(status === 204 || answer.body === undefined ? '' : JSON.stringify(answer.body));
        })();
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** Payloads the adapter is expected to be able to map. */
const ISSUE_PAYLOAD = {
  id: 9001,
  number: 7,
  title: 'A bug',
  body: 'It breaks',
  state: 'open',
  state_reason: null,
  user: { login: 'someone', type: 'User' },
  labels: [{ name: 'bug' }, 'chore'],
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
  html_url: 'https://github.com/anima-research/rayforce/issues/7',
};

const PULL_PAYLOAD = {
  number: 12,
  node_id: 'PR_node_12',
  title: 'Fix it',
  body: 'the fix',
  state: 'open',
  draft: false,
  merged: false,
  mergeable: true,
  head: { ref: 'fix/thing', sha: HEAD_SHA },
  base: { ref: 'dev', sha: 'babe0000' },
  user: { login: 'rayforce-clone[bot]', type: 'Bot' },
  requested_reviewers: [{ login: 'maintainer', type: 'User' }],
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-02T00:00:00Z',
  html_url: 'https://github.com/anima-research/rayforce/pull/12',
};

const COMMENT_PAYLOAD = {
  id: 555,
  user: { login: 'someone', type: 'User' },
  body: 'hello',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  html_url: 'https://github.com/anima-research/rayforce/issues/7#issuecomment-555',
};

/** A fake with every endpoint the contract's methods touch already answered. */
function defaultRoutes(fake: FakeGitHub, tokenExpiresInMs = 3_600_000, token = TOKEN): FakeGitHub {
  const r = '/repos/anima-research/rayforce';
  return fake
    .on(`POST /app/installations/${INSTALLATION_ID}/access_tokens`, () => ({
      status: 201,
      body: { token, expires_at: new Date(Date.now() + tokenExpiresInMs).toISOString() },
    }))
    .on(`GET ${r}/installation`, { body: { id: INSTALLATION_ID } })
    .on('GET /app', { body: { id: 777, slug: 'rayforce-clone', name: 'Rayforce Clone' } })
    .on(`GET ${r}/issues/7`, { body: ISSUE_PAYLOAD })
    .on(`POST ${r}/issues`, { status: 201, body: ISSUE_PAYLOAD })
    .on(`PATCH ${r}/issues/7`, { body: { ...ISSUE_PAYLOAD, state: 'closed', state_reason: 'not_planned' } })
    .on(`GET ${r}/issues/7/comments`, { body: [COMMENT_PAYLOAD] })
    .on(`POST ${r}/issues/7/comments`, { status: 201, body: COMMENT_PAYLOAD })
    .on(`PATCH ${r}/issues/comments/555`, { body: { ...COMMENT_PAYLOAD, body: 'edited' } })
    .on(`DELETE ${r}/issues/comments/555`, { status: 204 })
    .on(`PATCH ${r}/pulls/comments/555`, { body: { ...COMMENT_PAYLOAD, body: 'edited', path: 'a.ts' } })
    .on(`DELETE ${r}/pulls/comments/555`, { status: 204 })
    .on(`GET ${r}/pulls/12`, { body: PULL_PAYLOAD })
    .on(`PATCH ${r}/pulls/12`, { body: { ...PULL_PAYLOAD, title: 'Retitled' } })
    .on(`POST ${r}/pulls`, { status: 201, body: PULL_PAYLOAD })
    .on(`GET ${r}/pulls/12/files`, {
      body: [{ filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, changes: 4, patch: 'SECRET' }],
    })
    .on(`POST ${r}/pulls/12/reviews`, {
      status: 200,
      body: { id: 909, state: 'CHANGES_REQUESTED', html_url: 'https://github.com/x#pullrequestreview-909' },
    })
    .on(`POST ${r}/pulls/12/comments/555/replies`, { status: 201, body: { ...COMMENT_PAYLOAD, id: 556, path: 'a.ts', in_reply_to_id: 555 } })
    .on(`POST ${r}/pulls/12/requested_reviewers`, { status: 201, body: PULL_PAYLOAD })
    .on(`GET ${r}/commits/${HEAD_SHA}/check-runs`, { body: { total_count: 0, check_runs: [] } })
    .on('GET /search/issues', { body: { total_count: 1, items: [{ ...ISSUE_PAYLOAD, pull_request: { url: 'x' } }] } })
    .on(`GET ${r}/issues`, { body: [] })
    .on(`GET ${r}/issues/comments`, { body: [] })
    .on(`GET ${r}/pulls/comments`, { body: [] })
    .on('POST /graphql', { body: { data: {} } });
}

interface Rig {
  adapter: GitHubAdapter;
  fake: FakeGitHub;
  /** Every line the adapter logged, rendered the way stderr would render it. */
  logs: string[];
  /** Every backoff the adapter asked for, in milliseconds. */
  sleeps: number[];
  setNow: (ms: number) => void;
  /** The installation token this rig's fake hands out. */
  token: string;
}

const rigs: Rig[] = [];

async function rig(
  options: {
    tokenExpiresInMs?: number;
    env?: Record<string, string | undefined>;
    /** Override the minted token, e.g. with a form no pattern would catch. */
    token?: string;
  } = {},
): Promise<Rig> {
  const token = options.token ?? TOKEN;
  const fake = defaultRoutes(new FakeGitHub(), options.tokenExpiresInMs, token);
  await fake.start();

  const logs: string[] = [];
  const record = (level: string) => (message: string, fields?: Record<string, unknown>) => {
    logs.push(`${level} ${message} ${fields ? JSON.stringify(fields) : ''}`);
  };
  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };

  const sleeps: number[] = [];
  let now = Date.now();

  const adapter = new GitHubAdapter(config(options.env), {
    baseUrl: fake.baseUrl,
    logger,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => now,
  });

  const r: Rig = { adapter, fake, logs, sleeps, setNow: (ms) => (now = ms), token };
  rigs.push(r);
  return r;
}

after(async () => {
  await Promise.all(rigs.map((r) => r.fake.stop()));
});

/** The invariant every test shares: the token is in the header and nowhere else. */
function assertNoTokenLeak(r: Rig, extra: string[] = []): void {
  for (const line of [...r.logs, ...extra]) {
    assert.ok(!line.includes(r.token), `token leaked into: ${line}`);
  }
}

/** Spin the event loop until `predicate` holds, or give up and say so. */
async function waitFor(predicate: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Everything an error could carry a secret through: message, fields, stack. */
function renderError(err: unknown): string {
  const e = err as Error;
  return `${e.message}\n${e.stack ?? ''}\n${JSON.stringify(e, Object.getOwnPropertyNames(e))}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// App auth
// ─────────────────────────────────────────────────────────────────────────────

test('mints an App JWT the private key verifies, and swaps it for an installation token', async () => {
  const r = await rig();
  await r.adapter.getIssue(ISSUE);

  const mint = r.fake.for(`POST /app/installations/${INSTALLATION_ID}/access_tokens`);
  assert.equal(mint.length, 1);

  // The mint call is JWT-authenticated; the issue read is token-authenticated.
  const jwt = mint[0].headers.authorization;
  assert.ok(jwt.startsWith('Bearer '), `expected a JWT, got ${jwt.slice(0, 10)}…`);
  const [header, payload, signature] = jwt.slice('Bearer '.length).split('.');

  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
    iat: number;
    exp: number;
    iss: string;
  };
  assert.equal(claims.iss, APP_ID);
  assert.ok(claims.iat < Math.floor(Date.now() / 1000), 'iat is backdated against clock skew');
  assert.ok(claims.exp - claims.iat <= 600, `GitHub caps an App JWT at 10 minutes, got ${claims.exp - claims.iat}s`);

  assert.ok(
    verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      createPublicKey(KEY_PAIR.publicKey),
      Buffer.from(signature, 'base64url'),
    ),
    'the JWT signature does not verify against the App key',
  );

  assert.equal(r.fake.for('GET /repos/anima-research/rayforce/issues/7')[0].headers.authorization, `token ${TOKEN}`);
  assertNoTokenLeak(r);
});

test('caches the installation token across calls and re-mints it before it expires', async () => {
  // A token good for an hour is minted once however many calls are made.
  const long = await rig({ tokenExpiresInMs: 3_600_000 });
  await long.adapter.getIssue(ISSUE);
  await long.adapter.getIssue(ISSUE);
  await long.adapter.getIssue(ISSUE);
  assert.equal(long.fake.for(`POST /app/installations/${INSTALLATION_ID}/access_tokens`).length, 1);

  // A token inside the one-minute refresh margin is re-minted on every call.
  const short = await rig({ tokenExpiresInMs: 30_000 });
  await short.adapter.getIssue(ISSUE);
  await short.adapter.getIssue(ISSUE);
  assert.equal(short.fake.for(`POST /app/installations/${INSTALLATION_ID}/access_tokens`).length, 2);
  assertNoTokenLeak(short);
});

test('a token that has aged past its expiry is re-minted on the next call', async () => {
  const r = await rig({ tokenExpiresInMs: 3_600_000 });
  await r.adapter.getIssue(ISSUE);
  assert.equal(r.fake.for(`POST /app/installations/${INSTALLATION_ID}/access_tokens`).length, 1);

  r.setNow(Date.now() + 3_600_000); // the hour is up
  await r.adapter.getIssue(ISSUE);
  assert.equal(r.fake.for(`POST /app/installations/${INSTALLATION_ID}/access_tokens`).length, 2);
});

test('discovers the installation from GITHUB_REPOS when GITHUB_APP_INSTALLATION_ID is unset', async () => {
  const r = await rig({ env: { GITHUB_APP_INSTALLATION_ID: undefined } });
  await r.adapter.getIssue(ISSUE);

  const discovery = r.fake.for('GET /repos/anima-research/rayforce/installation');
  assert.equal(discovery.length, 1);
  assert.ok(discovery[0].headers.authorization.startsWith('Bearer '), 'discovery is JWT-authenticated');
  // Discovered once, then reused: the second call does not look it up again.
  await r.adapter.getIssue(ISSUE);
  assert.equal(r.fake.for('GET /repos/anima-research/rayforce/installation').length, 1);
  assert.equal(r.fake.for(`POST /app/installations/${INSTALLATION_ID}/access_tokens`).length, 1);
  assertNoTokenLeak(r);
});

test('a 401 on a call re-mints the token once and retries', async () => {
  const r = await rig();
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', (_req, nth) =>
    nth === 0 ? { status: 401, body: { message: 'Bad credentials' } } : { body: ISSUE_PAYLOAD },
  );

  const issue = await r.adapter.getIssue(ISSUE);
  assert.equal(issue.number, 7);
  assert.equal(r.fake.for('GET /repos/anima-research/rayforce/issues/7').length, 2);
  assert.equal(r.fake.for(`POST /app/installations/${INSTALLATION_ID}/access_tokens`).length, 2);
  assertNoTokenLeak(r);
});

test('a second 401 is not retried again; it surfaces as a 401 error', async () => {
  const r = await rig();
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', { status: 401, body: { message: 'Bad credentials' } });

  const err = await r.adapter.getIssue(ISSUE).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  assert.equal(err.status, 401);
  assert.equal(err.githubMessage, 'Bad credentials');
  assert.equal(r.fake.for('GET /repos/anima-research/rayforce/issues/7').length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// Rate limits
// ─────────────────────────────────────────────────────────────────────────────

test('a 403 secondary rate limit is retried once, after the Retry-After it names', async () => {
  const r = await rig();
  r.fake.on('POST /repos/anima-research/rayforce/issues/7/comments', (_req, nth) =>
    nth === 0
      ? {
          status: 403,
          headers: { 'retry-after': '3' },
          body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' },
        }
      : { status: 201, body: COMMENT_PAYLOAD },
  );

  const comment = await r.adapter.createComment(ISSUE, 'hello');
  assert.equal(comment.id, 555);
  assert.deepEqual(r.sleeps, [3000]);
  assert.equal(r.fake.for('POST /repos/anima-research/rayforce/issues/7/comments').length, 2);
  assertNoTokenLeak(r);
});

test('the secondary-limit retry is spent once; a second 403 is the caller’s error', async () => {
  const r = await rig();
  const message = 'You have exceeded a secondary rate limit.';
  r.fake.on('POST /repos/anima-research/rayforce/issues/7/comments', {
    status: 403,
    headers: { 'retry-after': '1' },
    body: { message },
  });

  const err = await r.adapter.createComment(ISSUE, 'hi').then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  assert.equal(err.status, 403);
  assert.equal(err.githubMessage, message);
  assert.deepEqual(r.sleeps, [1000], 'exactly one bounded retry');
  assert.equal(r.fake.for('POST /repos/anima-research/rayforce/issues/7/comments').length, 2);
});

test('a 403 with no Retry-After but a spent budget waits for the reset, bounded', async () => {
  const now = Date.now();
  const r = await rig();
  r.setNow(now);
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', (_req, nth) =>
    nth === 0
      ? {
          status: 403,
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(now / 1000) + 5),
          },
          body: { message: 'API rate limit exceeded' },
        }
      : { body: ISSUE_PAYLOAD },
  );

  await r.adapter.getIssue(ISSUE);
  assert.equal(r.sleeps.length, 1);
  assert.ok(r.sleeps[0] > 3_000 && r.sleeps[0] <= 5_000, `expected ~5s, got ${r.sleeps[0]}`);
});

test('a reset further out than the backoff bound is not slept on at all', async () => {
  const now = Date.now();
  const r = await rig();
  r.setNow(now);
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', {
    status: 403,
    headers: {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.floor(now / 1000) + 3600),
    },
    body: { message: 'API rate limit exceeded' },
  });

  await assert.rejects(r.adapter.getIssue(ISSUE), (e: unknown) => e instanceof GitHubApiError && e.status === 403);
  assert.deepEqual(r.sleeps, [], 'an hour-long reset is reported, not slept through');
  assert.equal(r.fake.for('GET /repos/anima-research/rayforce/issues/7').length, 1);
});

test('octokit’s own retry plugin is off, so a 5xx is one request and the caller’s error', async () => {
  const r = await rig();
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', { status: 500, body: { message: 'Server Error' } });

  await assert.rejects(r.adapter.getIssue(ISSUE), (e: unknown) => e instanceof GitHubApiError && e.status === 500);
  assert.equal(
    r.fake.for('GET /repos/anima-research/rayforce/issues/7').length,
    1,
    'a bundled plugin retrying underneath would make backoff unbounded and invisible',
  );
  assert.deepEqual(r.sleeps, []);
});

test('x-ratelimit-remaining is read off every answer and a low budget is warned about', async () => {
  const r = await rig();
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', {
    headers: { 'x-ratelimit-remaining': '3', 'x-ratelimit-reset': '1800000000' },
    body: ISSUE_PAYLOAD,
  });

  await r.adapter.getIssue(ISSUE);
  assert.deepEqual(r.adapter.rateLimitState(), { remaining: 3, resetAt: 1800000000000 });
  assert.ok(
    r.logs.some((l) => l.startsWith('warn github rate limit low')),
    `expected a low-budget warning, got ${JSON.stringify(r.logs)}`,
  );
  assertNoTokenLeak(r);
});

// ─────────────────────────────────────────────────────────────────────────────
// Error redaction
// ─────────────────────────────────────────────────────────────────────────────

test('an error carries the status and GitHub’s message, and no token, URL or header', async () => {
  const r = await rig();
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', {
    status: 404,
    body: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' },
  });

  const err = await r.adapter.getIssue(ISSUE).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  assert.equal(err.status, 404);
  assert.equal(err.githubMessage, 'Not Found');
  assert.equal(err.operation, 'getIssue');
  assert.equal(err.message, 'GitHub 404 on getIssue: Not Found');

  const rendered = `${err.message}\n${err.stack ?? ''}\n${JSON.stringify(err, Object.getOwnPropertyNames(err))}`;
  assert.ok(!rendered.includes(TOKEN), 'the token reached the error');
  assert.ok(!rendered.includes(r.fake.baseUrl), 'the request URL reached the error');
  assert.ok(!/authorization/i.test(rendered), 'a header name reached the error');
  assertNoTokenLeak(r, [rendered]);
});

test('no log line from a full session carries the token, however the calls went', async () => {
  const r = await rig({ tokenExpiresInMs: 30_000 });
  r.fake.on('GET /repos/anima-research/rayforce/pulls/12', (_req, nth) =>
    nth === 0 ? { status: 401, body: { message: 'Bad credentials' } } : { body: PULL_PAYLOAD },
  );
  r.fake.on('POST /repos/anima-research/rayforce/issues/7/comments', (_req, nth) =>
    nth === 0
      ? { status: 403, headers: { 'retry-after': '1' }, body: { message: 'secondary rate limit' } }
      : { status: 201, body: COMMENT_PAYLOAD },
  );

  await r.adapter.getPullRequest(PULL);
  await r.adapter.createComment(ISSUE, 'hi');
  await r.adapter.getIssue(ISSUE).catch(() => undefined);

  assert.ok(r.logs.length > 0, 'the session logged something, so the assertion is not vacuous');
  assertNoTokenLeak(r);
  // The token did travel — in the one place it belongs.
  assert.ok(
    r.fake.calls.some((c) => c.headers.authorization === `token ${TOKEN}`),
    'the installation token never reached the authorization header',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Review threads (GraphQL)
// ─────────────────────────────────────────────────────────────────────────────

test('listReviewThreads maps reviewThreads, isResolved and the comment chain', async () => {
  const r = await rig();
  r.fake.on('POST /graphql', {
    body: {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: 'PRRT_open',
                  path: 'src/a.ts',
                  line: 12,
                  originalLine: 9,
                  diffSide: 'RIGHT',
                  isResolved: false,
                  comments: {
                    nodes: [
                      {
                        databaseId: 100,
                        author: { login: 'maintainer', __typename: 'User' },
                        body: 'why?',
                        createdAt: '2026-10-01T00:00:00Z',
                        lastEditedAt: null,
                        replyTo: null,
                      },
                      {
                        databaseId: 101,
                        author: { login: 'rayforce-clone', __typename: 'Bot' },
                        body: 'because',
                        createdAt: '2026-10-01T01:00:00Z',
                        lastEditedAt: '2026-10-01T02:00:00Z',
                        replyTo: { databaseId: 100 },
                      },
                    ],
                  },
                },
                {
                  // Outdated: `line` is null and the original line stands in.
                  id: 'PRRT_outdated',
                  path: 'src/b.ts',
                  line: null,
                  originalLine: 42,
                  diffSide: 'LEFT',
                  isResolved: true,
                  comments: { nodes: [] },
                },
              ],
            },
          },
        },
      },
    },
  });

  const threads = await r.adapter.listReviewThreads(PULL);
  assert.equal(threads.length, 2);

  assert.deepEqual(threads[0], {
    id: 'PRRT_open',
    path: 'src/a.ts',
    line: 12,
    side: 'RIGHT',
    isResolved: false,
    comments: [
      {
        id: 100,
        author: { login: 'maintainer', isBot: false },
        body: 'why?',
        createdAt: '2026-10-01T00:00:00Z',
      },
      {
        id: 101,
        author: { login: 'rayforce-clone', isBot: true },
        body: 'because',
        createdAt: '2026-10-01T01:00:00Z',
        updatedAt: '2026-10-01T02:00:00Z',
        inReplyTo: 100,
      },
    ],
  });

  assert.equal(threads[1].id, 'PRRT_outdated');
  assert.equal(threads[1].line, 42, 'an outdated thread keeps its original line');
  assert.equal(threads[1].side, 'LEFT');
  assert.equal(threads[1].isResolved, true);

  // The query asked for exactly what the contract names, inside the 50 cap.
  const sent = r.fake.for('POST /graphql')[0];
  assert.match(String(sent.body.query), /reviewThreads\(first:\$threads\)/);
  assert.match(String(sent.body.query), /isResolved/);
  assert.deepEqual(sent.body.variables, {
    owner: 'anima-research',
    name: 'rayforce',
    number: 12,
    threads: 50,
    comments: 50,
  });
});

test('resolve and unresolve send their mutations with the thread node id', async () => {
  const r = await rig();
  r.fake.on('POST /graphql', { body: { data: { resolveReviewThread: { thread: { id: 'PRRT_x', isResolved: true } } } } });
  await r.adapter.resolveReviewThread('PRRT_x');
  await r.adapter.unresolveReviewThread('PRRT_x');

  const sent = r.fake.for('POST /graphql');
  assert.equal(sent.length, 2);
  assert.match(String(sent[0].body.query), /mutation.*resolveReviewThread\(input:\{threadId:\$threadId\}\)/s);
  assert.deepEqual(sent[0].body.variables, { threadId: 'PRRT_x' });
  assert.match(String(sent[1].body.query), /unresolveReviewThread\(input:\{threadId:\$threadId\}\)/);
  assert.deepEqual(sent[1].body.variables, { threadId: 'PRRT_x' });
});

test('a GraphQL errors array becomes a GitHubApiError, not a silent empty list', async () => {
  const r = await rig();
  r.fake.on('POST /graphql', { body: { data: null, errors: [{ message: 'Could not resolve to a PullRequest' }] } });

  const err = await r.adapter.listReviewThreads(PULL).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  assert.equal(err.githubMessage, 'Could not resolve to a PullRequest');
  assert.equal(err.operation, 'listReviewThreads');
  assert.ok(!err.message.includes(TOKEN));
});

// ─────────────────────────────────────────────────────────────────────────────
// Every GitHubApi method maps to its documented call
// ─────────────────────────────────────────────────────────────────────────────

test('every GitHubApi method is implemented on the adapter', async () => {
  const r = await rig();
  for (const name of GITHUB_API_METHODS) {
    assert.equal(typeof (r.adapter as unknown as Record<string, unknown>)[name], 'function', `missing ${name}`);
  }
});

test('reads hit the documented REST paths and map the payloads', async () => {
  const r = await rig();

  const issue = await r.adapter.getIssue(ISSUE);
  assert.deepEqual(issue, {
    number: 7,
    kind: 'issue',
    repo: REPO,
    title: 'A bug',
    body: 'It breaks',
    state: 'open',
    stateReason: null,
    author: { login: 'someone', isBot: false },
    labels: ['bug', 'chore'],
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    html_url: 'https://github.com/anima-research/rayforce/issues/7',
  });

  const pull = await r.adapter.getPullRequest(PULL);
  assert.equal(pull.kind, 'pull');
  assert.deepEqual(pull.head, { ref: 'fix/thing', sha: HEAD_SHA });
  assert.deepEqual(pull.base, { ref: 'dev', sha: 'babe0000' });
  assert.equal(pull.draft, false);
  assert.equal(pull.mergeable, true);
  assert.deepEqual(pull.author, { login: 'rayforce-clone[bot]', isBot: true });
  assert.deepEqual(pull.requestedReviewers, ['maintainer']);
  assert.equal(pull.checksSummary, null, 'no check runs on the head sha is null, not an empty summary');

  const files = await r.adapter.listPullRequestFiles(PULL);
  assert.deepEqual(files, [{ filename: 'src/a.ts', status: 'modified', additions: 3, deletions: 1, changes: 4 }]);
  assert.ok(!JSON.stringify(files).includes('SECRET'), 'the patch text must never be mapped through');

  const comments = await r.adapter.listComments(ISSUE, '2026-10-01T00:00:00Z');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].id, 555);
  const commentCall = r.fake.for('GET /repos/anima-research/rayforce/issues/7/comments')[0];
  assert.equal(commentCall.query.since, '2026-10-01T00:00:00Z');
  assert.equal(commentCall.query.per_page, '50', 'lists are capped at 50');

  const bot = await r.adapter.getAuthenticatedBot();
  assert.deepEqual(bot, { login: 'rayforce-clone[bot]', id: 777, isBot: true });
  assert.ok(r.fake.for('GET /app')[0].headers.authorization.startsWith('Bearer '), 'GET /app is JWT-authenticated');

  assertNoTokenLeak(r);
});

test('searchIssues scopes to the repository and drops a caller’s repo: qualifier', async () => {
  const r = await rig();
  const hits = await r.adapter.searchIssues(REPO, 'repo:someone/else is:open flaky');

  assert.deepEqual(hits, [
    {
      number: 7,
      kind: 'pull',
      title: 'A bug',
      state: 'open',
      updatedAt: '2026-10-02T00:00:00Z',
      html_url: 'https://github.com/anima-research/rayforce/issues/7',
    },
  ]);
  const sent = r.fake.for('GET /search/issues')[0];
  assert.equal(sent.query.q, 'repo:anima-research/rayforce is:open flaky');
  assert.equal(sent.query.per_page, '50');

  // An explicit limit is honoured but never exceeds the rendered list bound.
  await r.adapter.searchIssues(REPO, 'x', 5);
  assert.equal(r.fake.for('GET /search/issues')[1].query.per_page, '5');
  await r.adapter.searchIssues(REPO, 'x', 500);
  assert.equal(r.fake.for('GET /search/issues')[2].query.per_page, '50');
});

test('getCheckRuns rolls a sha’s runs up and lists the failures', async () => {
  const r = await rig();
  r.fake.on(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`, {
    body: {
      total_count: 4,
      check_runs: [
        { name: 'build', status: 'completed', conclusion: 'success', html_url: 'https://ci/build' },
        { name: 'lint', status: 'completed', conclusion: 'failure', html_url: 'https://ci/lint' },
        { name: 'docs', status: 'completed', conclusion: 'skipped', html_url: 'https://ci/docs' },
        { name: 'e2e', status: 'completed', conclusion: 'cancelled', html_url: 'https://ci/e2e' },
      ],
    },
  });

  const summary = await r.adapter.getCheckRuns(REPO, HEAD_SHA);
  assert.equal(summary.sha, HEAD_SHA);
  assert.equal(summary.total, 4);
  assert.equal(summary.conclusion, 'failure', 'the worst conclusion wins');
  assert.deepEqual(summary.failed, [
    { name: 'lint', url: 'https://ci/lint' },
    { name: 'e2e', url: 'https://ci/e2e' },
  ]);

  // A pull request read folds the same summary in.
  const pull = await r.adapter.getPullRequest(PULL);
  assert.equal(pull.checksSummary?.conclusion, 'failure');
});

test('summarizeChecks: running is undecided, all-clear is success, empty is null', () => {
  assert.equal(summarizeChecks('s', []).conclusion, null);
  assert.equal(
    summarizeChecks('s', [{ name: 'a', status: 'in_progress', conclusion: null }]).conclusion,
    null,
    'a run still going leaves the sha undecided',
  );
  assert.equal(
    summarizeChecks('s', [
      { name: 'a', status: 'completed', conclusion: 'success' },
      { name: 'b', status: 'completed', conclusion: 'neutral' },
    ]).conclusion,
    'success',
    'neutral is not a failure',
  );
  assert.equal(
    summarizeChecks('s', [
      { name: 'a', status: 'completed', conclusion: 'timed_out' },
      { name: 'b', status: 'completed', conclusion: 'failure' },
    ]).conclusion,
    'failure',
  );
});

test('comment writes hit the issues or pulls comment path as `review` says', async () => {
  const r = await rig();

  await r.adapter.createComment(ISSUE, 'hello');
  assert.deepEqual(r.fake.for('POST /repos/anima-research/rayforce/issues/7/comments')[0].body, { body: 'hello' });

  await r.adapter.updateComment(REPO, 555, 'edited');
  assert.deepEqual(r.fake.for('PATCH /repos/anima-research/rayforce/issues/comments/555')[0].body, { body: 'edited' });

  const reviewEdit = await r.adapter.updateComment(REPO, 555, 'edited', true);
  assert.equal(r.fake.for('PATCH /repos/anima-research/rayforce/pulls/comments/555').length, 1);
  assert.equal(reviewEdit.path, 'a.ts');
  assert.equal(reviewEdit.side, 'RIGHT');

  await r.adapter.deleteComment(REPO, 555);
  assert.equal(r.fake.for('DELETE /repos/anima-research/rayforce/issues/comments/555').length, 1);
  await r.adapter.deleteComment(REPO, 555, true);
  assert.equal(r.fake.for('DELETE /repos/anima-research/rayforce/pulls/comments/555').length, 1);

  const reply = await r.adapter.replyToReviewComment(PULL, 555, 'answering');
  assert.deepEqual(r.fake.for('POST /repos/anima-research/rayforce/pulls/12/comments/555/replies')[0].body, {
    body: 'answering',
  });
  assert.equal(reply.inReplyTo, 555);
  assertNoTokenLeak(r);
});

test('createReview posts the event, body and inline comments', async () => {
  const r = await rig();
  const review = await r.adapter.createReview(PULL, {
    event: 'REQUEST_CHANGES',
    body: 'two things',
    comments: [{ path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'this one' }],
  });

  assert.deepEqual(review, { id: 909, state: 'changes_requested', html_url: 'https://github.com/x#pullrequestreview-909' });
  assert.deepEqual(r.fake.for('POST /repos/anima-research/rayforce/pulls/12/reviews')[0].body, {
    event: 'REQUEST_CHANGES',
    body: 'two things',
    comments: [{ path: 'src/a.ts', line: 12, side: 'RIGHT', body: 'this one' }],
  });

  // A bare COMMENT review sends no empty `comments` array.
  await r.adapter.createReview(PULL, { event: 'COMMENT' });
  assert.deepEqual(r.fake.for('POST /repos/anima-research/rayforce/pulls/12/reviews')[1].body, { event: 'COMMENT' });
});

test('issue create, edit and close-with-reason go through one PATCH', async () => {
  const r = await rig();

  await r.adapter.createIssue(REPO, { title: 'New', body: 'text' });
  assert.deepEqual(r.fake.for('POST /repos/anima-research/rayforce/issues')[0].body, { title: 'New', body: 'text' });

  const closed = await r.adapter.updateIssue(ISSUE, { state: 'closed', stateReason: 'not_planned' });
  assert.deepEqual(r.fake.for('PATCH /repos/anima-research/rayforce/issues/7')[0].body, {
    state: 'closed',
    state_reason: 'not_planned',
  });
  assert.equal(closed.state, 'closed');
  assert.equal(closed.stateReason, 'not_planned');

  // An absent field is absent from the body, not sent as null.
  await r.adapter.updateIssue(ISSUE, { title: 'Retitled' });
  assert.deepEqual(r.fake.for('PATCH /repos/anima-research/rayforce/issues/7')[1].body, { title: 'Retitled' });
});

test('pull request create, retarget, reviewers — and the draft flag through GraphQL', async () => {
  const r = await rig();

  await r.adapter.createPullRequest(REPO, { head: 'fix/thing', base: 'dev', title: 'Fix it', body: 'the fix', draft: true });
  assert.deepEqual(r.fake.for('POST /repos/anima-research/rayforce/pulls')[0].body, {
    head: 'fix/thing',
    base: 'dev',
    title: 'Fix it',
    body: 'the fix',
    draft: true,
  });

  const retargeted = await r.adapter.updatePullRequest(PULL, { title: 'Retitled', base: 'dev' });
  assert.deepEqual(r.fake.for('PATCH /repos/anima-research/rayforce/pulls/12')[0].body, {
    title: 'Retitled',
    base: 'dev',
  });
  assert.equal(retargeted.title, 'Retitled');
  assert.equal(r.fake.for('POST /graphql').length, 0, 'no draft change means no mutation');

  await r.adapter.requestReviewers(PULL, ['maintainer', 'other']);
  assert.deepEqual(r.fake.for('POST /repos/anima-research/rayforce/pulls/12/requested_reviewers')[0].body, {
    reviewers: ['maintainer', 'other'],
  });

  // REST cannot convert a PR to draft; GraphQL can, and the adapter re-reads.
  r.fake.on('GET /repos/anima-research/rayforce/pulls/12', (_req, nth) =>
    nth === 0 ? { body: PULL_PAYLOAD } : { body: { ...PULL_PAYLOAD, draft: true } },
  );
  const drafted = await r.adapter.updatePullRequest(PULL, { draft: true });
  const mutation = r.fake.for('POST /graphql')[0];
  assert.match(String(mutation.body.query), /convertPullRequestToDraft\(input:\{pullRequestId:\$id\}\)/);
  assert.deepEqual(mutation.body.variables, { id: 'PR_node_12' });
  assert.equal(drafted.draft, true);

  // Already a draft: no mutation is sent.
  r.fake.on('GET /repos/anima-research/rayforce/pulls/12', { body: { ...PULL_PAYLOAD, draft: true } });
  await r.adapter.updatePullRequest(PULL, { draft: true });
  assert.equal(r.fake.for('POST /graphql').length, 1, 'a no-op draft change sends nothing');

  // Ready for review takes the other mutation.
  r.fake.on('GET /repos/anima-research/rayforce/pulls/12', (_req, nth) =>
    nth === 0 ? { body: { ...PULL_PAYLOAD, draft: true } } : { body: PULL_PAYLOAD },
  );
  await r.adapter.updatePullRequest(PULL, { draft: false });
  assert.match(String(r.fake.for('POST /graphql')[1].body.query), /markPullRequestReadyForReview/);
  assertNoTokenLeak(r);
});

// ─────────────────────────────────────────────────────────────────────────────
// Polling fallback (contract amendment 1)
// ─────────────────────────────────────────────────────────────────────────────

test('listIssuesSince asks the documented query and fills the head sha of open PRs', async () => {
  const r = await rig();
  const since = '2026-10-10T00:00:00Z';
  r.fake.on('GET /repos/anima-research/rayforce/issues', {
    body: [
      { ...ISSUE_PAYLOAD, id: 1, number: 7 },
      { ...ISSUE_PAYLOAD, id: 2, number: 12, pull_request: { url: 'x' }, state: 'open' },
      {
        ...ISSUE_PAYLOAD,
        id: 3,
        number: 13,
        pull_request: { url: 'x' },
        state: 'closed',
        closed_by: { login: 'rayforce-clone[bot]', type: 'Bot' },
      },
    ],
  });

  const rows = await r.adapter.listIssuesSince(REPO, since);
  // The list carries closed_by; a closed row is attributed to its closer.
  assert.deepEqual(rows[2].closedBy, { login: 'rayforce-clone[bot]', isBot: true });
  assert.equal(rows[0].closedBy, undefined);
  const query = r.fake.for('GET /repos/anima-research/rayforce/issues')[0].query;
  assert.equal(query.state, 'all');
  assert.equal(query.sort, 'updated');
  assert.equal(query.since, since);
  assert.equal(query.direction, 'asc', 'a cursor poll must read oldest-first');

  assert.deepEqual(
    rows.map((row) => [row.id, row.number, row.isPullRequest, row.headSha]),
    [
      [1, 7, false, undefined],
      [2, 12, true, HEAD_SHA],
      [3, 13, true, undefined],
    ],
  );
  // Exactly one head read: the closed PR and the issue cost nothing.
  assert.equal(r.fake.for('GET /repos/anima-research/rayforce/pulls/12').length, 1);
});

test('the issues poll pages up to its documented bound and no further', async () => {
  const r = await rig();
  const page = (n: number) =>
    Array.from({ length: 100 }, (_, i) => ({ ...ISSUE_PAYLOAD, id: n * 1000 + i, number: n * 1000 + i }));
  r.fake.on('GET /repos/anima-research/rayforce/issues', (req) => ({ body: page(Number(req.query.page)) }));

  const rows = await r.adapter.listIssuesSince(REPO, '2026-10-10T00:00:00Z');
  assert.equal(rows.length, POLL_MAX_ENTRIES);
  assert.deepEqual(
    r.fake.for('GET /repos/anima-research/rayforce/issues').map((c) => c.query.page),
    ['1', '2', '3'],
  );
  assert.ok(
    r.logs.some((l) => l.startsWith('warn poll page cap reached')),
    'a capped poll says so rather than dropping rows silently',
  );
});

test('a poll never reads more than the amendment’s 20 PR heads', async () => {
  const r = await rig();
  r.fake.on('GET /repos/anima-research/rayforce/issues', {
    body: Array.from({ length: 30 }, (_, i) => ({
      ...ISSUE_PAYLOAD,
      id: i,
      number: 100 + i,
      state: 'open',
      pull_request: { url: 'x' },
    })),
  });
  for (let i = 0; i < 30; i++) {
    r.fake.on(`GET /repos/anima-research/rayforce/pulls/${100 + i}`, {
      body: { ...PULL_PAYLOAD, number: 100 + i },
    });
  }

  const rows = await r.adapter.listIssuesSince(REPO, '2026-10-10T00:00:00Z');
  assert.equal(rows.filter((row) => row.headSha !== undefined).length, POLL_PR_HEAD_LIMIT);
});

test('the comment polls carry the issue or pull number the comment hangs on', async () => {
  const r = await rig();
  const since = '2026-10-10T00:00:00Z';
  r.fake.on('GET /repos/anima-research/rayforce/issues/comments', {
    body: [{ ...COMMENT_PAYLOAD, issue_url: 'https://api.github.com/repos/anima-research/rayforce/issues/7' }],
  });
  r.fake.on('GET /repos/anima-research/rayforce/pulls/comments', {
    body: [
      {
        ...COMMENT_PAYLOAD,
        id: 556,
        path: 'src/a.ts',
        in_reply_to_id: 555,
        pull_request_url: 'https://api.github.com/repos/anima-research/rayforce/pulls/12',
      },
    ],
  });

  const issueComments = await r.adapter.listIssueCommentsSince(REPO, since);
  assert.equal(issueComments.length, 1);
  assert.equal(issueComments[0].number, 7);
  assert.equal(issueComments[0].path, undefined);
  assert.equal(r.fake.for('GET /repos/anima-research/rayforce/issues/comments')[0].query.sort, 'updated');
  assert.equal(r.fake.for('GET /repos/anima-research/rayforce/issues/comments')[0].query.since, since);

  const reviewComments = await r.adapter.listReviewCommentsSince(REPO, since);
  assert.equal(reviewComments[0].number, 12);
  assert.equal(reviewComments[0].path, 'src/a.ts');
  assert.equal(reviewComments[0].inReplyTo, 555);
  assert.equal(r.fake.for('GET /repos/anima-research/rayforce/pulls/comments')[0].query.since, since);
  assertNoTokenLeak(r);
});

// ─────────────────────────────────────────────────────────────────────────────
// Review round 1: redaction of reflected secrets
// ─────────────────────────────────────────────────────────────────────────────

test('redactSecrets scrubs token forms and URL userinfo, and leaves prose alone', () => {
  assert.equal(redactSecrets('bad credentials for ghs_abc123DEF'), `bad credentials for ${REDACTED}`);
  for (const prefix of ['ghp_', 'gho_', 'ghu_', 'ghr_']) {
    assert.equal(redactSecrets(`saw ${prefix}aaaaBBBB1111`), `saw ${REDACTED}`);
  }
  assert.equal(
    redactSecrets('request to https://octocat:hunter2@api.github.com/repos failed'),
    `request to https://${REDACTED}@api.github.com/repos failed`,
  );
  // The JWT pattern fires first and leaves the scheme word standing, which is
  // the point: the credential is gone and the message still reads.
  assert.equal(
    redactSecrets('header was Bearer eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiIxIn0.c2lnbmF0dXJl'),
    `header was Bearer ${REDACTED}`,
  );
  assert.equal(redactSecrets('header was token 0123456789abcdef'), `header was ${REDACTED}`);
  // An ordinary message and an ordinary URL come through untouched.
  assert.equal(
    redactSecrets('Not Found — see https://api.github.com/repos/anima-research/rayforce'),
    'Not Found — see https://api.github.com/repos/anima-research/rayforce',
  );
});

test('a GitHub error that reflects the live token back redacts it everywhere', async () => {
  const r = await rig();
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', {
    status: 422,
    body: { message: `Bad credentials for ${TOKEN} on this installation` },
  });

  const err = await r.adapter.getIssue(ISSUE).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  assert.equal(err.status, 422);
  const rendered = renderError(err);
  assert.ok(!rendered.includes(TOKEN), 'the reflected token survived into the error');
  assert.ok(err.githubMessage.includes(REDACTED), `expected a redaction, got: ${err.githubMessage}`);
  assert.ok(err.githubMessage.includes('Bad credentials'), 'the rest of the message is still there');
  assertNoTokenLeak(r, [rendered]);
});

test('a token with no recognizable shape is still redacted, because its value is known', async () => {
  // GitHub's older installation tokens are `v1.<hex>` — no `ghs_`, nothing a
  // pattern would catch. Only substituting the value in hand scrubs it.
  // Built at run time: spelled out, it is exactly what secret scanners match,
  // and GitHub push protection refuses the file.
  const opaque = `v1.${'0123456789abcdef'.repeat(3).slice(0, 40)}`;
  const r = await rig({ token: opaque });
  assert.equal(redactSecrets(opaque), opaque, 'the premise: no pattern matches this token');

  r.fake.on('GET /repos/anima-research/rayforce/issues/7', {
    status: 401,
    body: { message: `credentials ${opaque} are not valid` },
  });

  const err = await r.adapter.getIssue(ISSUE).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  const rendered = renderError(err);
  assert.ok(!rendered.includes(opaque), 'the opaque token survived into the error');
  assert.ok(err.githubMessage.includes(REDACTED));
  assertNoTokenLeak(r, [rendered]);
});

test('a credential-bearing URL reflected in an error loses its userinfo', async () => {
  const r = await rig();
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', {
    status: 502,
    body: { message: 'upstream https://octocat:hunter2@api.github.com/repos/x refused the connection' },
  });

  const err = await r.adapter.getIssue(ISSUE).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  const rendered = renderError(err);
  assert.ok(!rendered.includes('hunter2'), 'the password survived into the error');
  assert.ok(!rendered.includes('octocat:'), 'the userinfo survived into the error');
  assert.ok(err.githubMessage.includes(`https://${REDACTED}@api.github.com`));
});

test('a baseUrl with credentials in its userinfo is refused before any request', () => {
  const err = (() => {
    try {
      new GitHubAdapter(config(), { baseUrl: 'https://octocat:hunter2@api.github.com' });
      return null;
    } catch (e: unknown) {
      return e as GitHubApiError;
    }
  })();

  assert.ok(err instanceof GitHubApiError, 'a credential-bearing baseUrl must be refused');
  assert.equal(err.operation, 'constructor');
  const rendered = renderError(err);
  assert.ok(!rendered.includes('hunter2'), 'the refusal quoted the password back');
  assert.ok(!rendered.includes('octocat'), 'the refusal quoted the user back');
  assert.match(err.githubMessage, /userinfo/);
});

test('a log line built from a reflected secret is redacted too', async () => {
  const r = await rig();
  // The retry warning carries the operation, but the rate-limit path also logs
  // what GitHub said; drive a secondary limit whose message quotes the token.
  r.fake.on('POST /repos/anima-research/rayforce/issues/7/comments', {
    status: 403,
    headers: { 'retry-after': '1' },
    body: { message: `secondary rate limit hit by ${TOKEN}` },
  });

  const err = await r.adapter.createComment(ISSUE, 'hi').then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  assert.ok(r.logs.length > 0);
  assertNoTokenLeak(r, [renderError(err)]);
});

// ─────────────────────────────────────────────────────────────────────────────
// Review round 1: check runs are paginated
// ─────────────────────────────────────────────────────────────────────────────

function successRuns(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    name: `job-${from + i}`,
    status: 'completed',
    conclusion: 'success',
    html_url: `https://ci/${from + i}`,
  }));
}

test('getCheckRuns follows pages, so a failure on page two is not reported as success', async () => {
  const r = await rig();
  r.fake.on(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`, (req) => ({
    body: {
      total_count: 101,
      check_runs:
        Number(req.query.page) === 1
          ? successRuns(0, 100)
          : [{ name: 'late-failure', status: 'completed', conclusion: 'failure', html_url: 'https://ci/late' }],
    },
  }));

  const summary = await r.adapter.getCheckRuns(REPO, HEAD_SHA);
  assert.equal(summary.total, 101, 'the 101st run is counted');
  assert.equal(summary.conclusion, 'failure', 'a failure on page two is a failure');
  assert.deepEqual(summary.failed, [{ name: 'late-failure', url: 'https://ci/late' }]);
  assert.deepEqual(
    r.fake.for(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`).map((c) => c.query.page),
    ['1', '2'],
  );
});

test('a sha with more check runs than the page bound is undecided, never success', async () => {
  const r = await rig();
  r.fake.on(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`, (req) => ({
    body: { total_count: 1000, check_runs: successRuns((Number(req.query.page) - 1) * 100, 100) },
  }));

  const summary = await r.adapter.getCheckRuns(REPO, HEAD_SHA);
  assert.equal(summary.conclusion, null, 'what was not read cannot be called green');
  assert.equal(summary.total, 1000);
  assert.equal(r.fake.for(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`).length, 5);
  assert.ok(
    r.logs.some((l) => l.startsWith('warn check runs did not fit')),
    `expected a truncation warning, got ${JSON.stringify(r.logs)}`,
  );
});

test('a single complete page still stops at one request', async () => {
  const r = await rig();
  r.fake.on(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`, {
    body: { total_count: 2, check_runs: successRuns(0, 2) },
  });

  const summary = await r.adapter.getCheckRuns(REPO, HEAD_SHA);
  assert.equal(summary.conclusion, 'success');
  assert.equal(summary.total, 2);
  assert.equal(r.fake.for(`GET /repos/anima-research/rayforce/commits/${HEAD_SHA}/check-runs`).length, 1);
});

test('summarizeChecks refuses to call a truncated read success', () => {
  const complete = summarizeChecks('s', successRuns(0, 3));
  assert.equal(complete.conclusion, 'success');
  assert.equal(complete.total, 3);

  const partial = summarizeChecks('s', successRuns(0, 3), { total: 9, truncated: true });
  assert.equal(partial.conclusion, null);
  assert.equal(partial.total, 9);

  // A failure already seen stands whatever is still unread.
  const failing = summarizeChecks(
    's',
    [{ name: 'x', status: 'completed', conclusion: 'failure', html_url: 'u' }],
    { total: 9, truncated: true },
  );
  assert.equal(failing.conclusion, 'failure');
});

// ─────────────────────────────────────────────────────────────────────────────
// Review round 1: a headerless secondary limit waits a full minute
// ─────────────────────────────────────────────────────────────────────────────

test('a secondary limit with no Retry-After waits the minute GitHub asks for', async () => {
  const r = await rig();
  r.fake.on('POST /repos/anima-research/rayforce/issues/7/comments', (_req, nth) =>
    nth === 0
      ? {
          // No `retry-after`, and the budget is not spent: only the message
          // says what happened.
          status: 403,
          body: { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' },
        }
      : { status: 201, body: COMMENT_PAYLOAD },
  );

  const comment = await r.adapter.createComment(ISSUE, 'hello');
  assert.equal(comment.id, 555);
  assert.deepEqual(r.sleeps, [60_000], 'retrying a secondary limit sooner than a minute earns the next one');
  assert.equal(r.fake.for('POST /repos/anima-research/rayforce/issues/7/comments').length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
// Review round 1: auth failures keep their status
// ─────────────────────────────────────────────────────────────────────────────

test('a failure minting the installation token keeps its status and names the mint', async () => {
  const r = await rig();
  r.fake.on(`POST /app/installations/${INSTALLATION_ID}/access_tokens`, {
    status: 403,
    body: { message: 'Resource not accessible by integration' },
  });

  const err = await r.adapter.getIssue(ISSUE).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  assert.equal(err.status, 403, 'the auth status must survive octokit wrapping it as a transport 500');
  assert.equal(err.githubMessage, 'Resource not accessible by integration');
  assert.equal(err.operation, 'mintInstallationToken');
  // The call it was blocking never went out.
  assert.equal(r.fake.for('GET /repos/anima-research/rayforce/issues/7').length, 0);
  assertNoTokenLeak(r, [renderError(err)]);
});

test('a failure discovering the installation keeps its status and names the discovery', async () => {
  const r = await rig({ env: { GITHUB_APP_INSTALLATION_ID: undefined } });
  r.fake.on('GET /repos/anima-research/rayforce/installation', {
    status: 404,
    body: { message: 'Not Found' },
  });

  const err = await r.adapter.getPullRequest(PULL).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  assert.equal(err.status, 404);
  assert.equal(err.githubMessage, 'Not Found');
  assert.equal(err.operation, 'resolveInstallationId');
  assert.equal(r.fake.for(`POST /app/installations/${INSTALLATION_ID}/access_tokens`).length, 0);
});

test('an auth failure on a GraphQL call keeps its status too', async () => {
  const r = await rig();
  r.fake.on(`POST /app/installations/${INSTALLATION_ID}/access_tokens`, {
    status: 401,
    body: { message: 'A JSON web token could not be decoded' },
  });

  const err = await r.adapter.listReviewThreads(PULL).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  assert.equal(err.status, 401);
  assert.equal(err.operation, 'mintInstallationToken');
  assert.equal(r.fake.for('POST /graphql').length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Review round 1: octokit's own diagnostics go through the Logger
// ─────────────────────────────────────────────────────────────────────────────

test('octokit’s deprecation warning reaches the injected Logger, not stderr', async () => {
  const r = await rig();
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', {
    headers: { deprecation: 'true', sunset: '2026-12-01' },
    body: ISSUE_PAYLOAD,
  });

  const stderrWrites: string[] = [];
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderrWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;
  try {
    await r.adapter.getIssue(ISSUE);
  } finally {
    process.stderr.write = original;
  }

  assert.ok(
    r.logs.some((l) => l.includes('octokit:') && l.includes('deprecated')),
    `expected octokit's warning on the Logger, got ${JSON.stringify(r.logs)}`,
  );
  assert.deepEqual(stderrWrites, [], 'octokit wrote straight to stderr, bypassing the Logger');
  assertNoTokenLeak(r);
});

test('an octokit diagnostic is redacted like any other log line', async () => {
  const r = await rig();
  // The deprecation warning quotes the request URL back; make that URL carry
  // something that must not be logged.
  r.fake.on(`GET /repos/anima-research/rayforce/commits/ghs_LEAKED_IN_A_URL/check-runs`, {
    headers: { deprecation: 'true', sunset: '2026-12-01' },
    body: { total_count: 0, check_runs: [] },
  });

  await r.adapter.getCheckRuns(REPO, 'ghs_LEAKED_IN_A_URL');
  const octokitLines = r.logs.filter((l) => l.includes('octokit:'));
  assert.equal(octokitLines.length, 1, `expected one octokit line, got ${JSON.stringify(r.logs)}`);
  assert.ok(!octokitLines[0].includes('ghs_LEAKED_IN_A_URL'), 'octokit’s own message was not redacted');
  assert.ok(octokitLines[0].includes(REDACTED));
});

// ─────────────────────────────────────────────────────────────────────────────
// Review round 2: a credential is not safe the moment it is replaced
// ─────────────────────────────────────────────────────────────────────────────

test('a token still in flight when a refresh replaces it is redacted all the same', async () => {
  // Two opaque tokens, of the `v1.<hex>` form GitHub used to issue: no pattern
  // recognizes either, so only substituting the literal values can scrub them,
  // and only remembering both can scrub the one already replaced.
  const TOKEN_A = 'v1.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const TOKEN_B = 'v1.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  assert.equal(redactSecrets(TOKEN_A), TOKEN_A, 'the premise: no pattern catches these');
  assert.equal(redactSecrets(TOKEN_B), TOKEN_B);

  const r = await rig();
  const start = Date.now();
  r.setNow(start);

  const issued: string[] = [];
  r.fake.on(`POST /app/installations/${INSTALLATION_ID}/access_tokens`, (_req, nth) => {
    const token = nth === 0 ? TOKEN_A : TOKEN_B;
    issued.push(token);
    // Both tokens claim the same expiry; the clock is what moves.
    return { status: 201, body: { token, expires_at: new Date(start + 3_600_000).toISOString() } };
  });

  // The first request is held open by the fake, mid-flight, carrying token A.
  let release!: (answer: Answer) => void;
  const held = new Promise<Answer>((resolve) => {
    release = resolve;
  });
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', () => held);

  const inFlight = r.adapter.getIssue(ISSUE).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  await waitFor(() => r.fake.for('GET /repos/anima-research/rayforce/issues/7').length === 1, 'the held request');
  assert.deepEqual(issued, [TOKEN_A]);
  assert.equal(
    r.fake.for('GET /repos/anima-research/rayforce/issues/7')[0].headers.authorization,
    `token ${TOKEN_A}`,
    'the held request really is carrying token A',
  );

  // The clock moves into the refresh margin and a second request completes,
  // which mints token B and replaces the cache out from under the first.
  r.setNow(start + 3_600_000 - 30_000);
  await r.adapter.listComments(ISSUE);
  assert.deepEqual(issued, [TOKEN_A, TOKEN_B], 'the refresh minted a distinct token');

  // Only now does the held request fail, with GitHub reflecting token A back.
  release({ status: 422, body: { message: `Bad credentials for ${TOKEN_A} on this installation` } });
  const err = await inFlight;

  assert.ok(err instanceof GitHubApiError);
  assert.equal(err.status, 422);
  for (const [name, secret] of [
    ['the replaced token', TOKEN_A],
    ['the current token', TOKEN_B],
  ] as const) {
    assert.ok(!err.message.includes(secret), `${name} survived into message`);
    assert.ok(!err.githubMessage.includes(secret), `${name} survived into githubMessage`);
    assert.ok(!(err.stack ?? '').includes(secret), `${name} survived into the stack`);
    assert.ok(!JSON.stringify(err).includes(secret), `${name} survived into JSON.stringify`);
    assert.ok(!renderError(err).includes(secret), `${name} survived into the serialized error`);
  }
  assert.ok(err.githubMessage.includes(REDACTED), `expected a redaction, got: ${err.githubMessage}`);
  assert.ok(err.githubMessage.includes('Bad credentials'), 'the rest of the message is still there');
  for (const line of r.logs) {
    assert.ok(!line.includes(TOKEN_A) && !line.includes(TOKEN_B), `a token leaked into: ${line}`);
  }
});

/**
 * An opaque `v1.<hex>` token, the form GitHub used to issue: no pattern in
 * `redactSecrets` recognizes it, so only the value passes can scrub it. Every
 * rotation test below depends on that, and asserts it.
 */
function opaqueToken(n: number): string {
  return `v1.${String(n).padStart(2, '0')}${'c'.repeat(38)}`;
}

/**
 * Answer every mint with a fresh opaque token. Returns the list, which grows
 * as the adapter rotates.
 */
function rotatingTokens(r: Rig, expiresAt: number): string[] {
  const issued: string[] = [];
  r.fake.on(`POST /app/installations/${INSTALLATION_ID}/access_tokens`, (_req, nth) => {
    const token = opaqueToken(nth);
    issued.push(token);
    return { status: 201, body: { token, expires_at: new Date(expiresAt).toISOString() } };
  });
  return issued;
}

test('no rotation ages a credential out while the request that sent it is unresolved', async () => {
  // The reviewer's probe, verbatim in shape: one held request, then enough
  // 401-driven rotations to overflow any fixed-size history, no clock advance
  // and never more than two application requests pending.
  const r = await rig();
  const start = Date.now();
  r.setNow(start);
  const issued = rotatingTokens(r, start + 3_600_000);

  // The held request goes out under the first token and stays unresolved.
  let release!: (answer: Answer) => void;
  const held = new Promise<Answer>((resolve) => {
    release = resolve;
  });
  r.fake.on('GET /repos/anima-research/rayforce/issues/7', () => held);

  const inFlight = r.adapter.getIssue(ISSUE).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  await waitFor(() => r.fake.for('GET /repos/anima-research/rayforce/issues/7').length === 1, 'the held request');
  const tokenA = issued[0];
  assert.equal(
    r.fake.for('GET /repos/anima-research/rayforce/issues/7')[0].headers.authorization,
    `token ${tokenA}`,
    'the held request really is carrying the first token',
  );
  assert.equal(redactSecrets(tokenA), tokenA, 'the premise: no pattern catches these tokens');

  // Ten sequential calls, each refused once and retried, which mints a fresh
  // token every time. No clock advance: rotation alone drives this.
  r.fake.on('GET /repos/anima-research/rayforce/issues/7/comments', (_req, nth) =>
    nth % 2 === 0 ? { status: 401, body: { message: 'Bad credentials' } } : { body: [COMMENT_PAYLOAD] },
  );
  const ROTATIONS = 10;
  for (let i = 0; i < ROTATIONS; i++) await r.adapter.listComments(ISSUE);
  assert.equal(issued.length, ROTATIONS + 1, 'every 401 retry minted a distinct token');
  assert.ok(issued.length > 9, 'more rotations than any fixed-size history would hold');
  assert.equal(new Set(issued).size, issued.length, 'the tokens really are all distinct');

  // Only now does the held request fail, with GitHub reflecting every token
  // that has existed during its lifetime.
  release({ status: 422, body: { message: `rejected: ${issued.join(' ')}` } });
  const err = await inFlight;

  assert.ok(err instanceof GitHubApiError);
  assert.equal(err.status, 422);
  for (const [i, token] of issued.entries()) {
    assert.ok(!err.message.includes(token), `token ${i} survived into message`);
    assert.ok(!err.githubMessage.includes(token), `token ${i} survived into githubMessage`);
    assert.ok(!(err.stack ?? '').includes(token), `token ${i} survived into the stack`);
    assert.ok(!JSON.stringify(err).includes(token), `token ${i} survived into JSON.stringify`);
    assert.ok(!renderError(err).includes(token), `token ${i} survived into the serialized error`);
  }
  assert.ok(err.githubMessage.includes(REDACTED));
  assert.ok(err.githubMessage.includes('rejected:'), 'the rest of the message is still there');
  for (const line of r.logs) {
    for (const token of issued) assert.ok(!line.includes(token), `a token leaked into: ${line}`);
  }
});

test('retention is by validity, so a credential GitHub would refuse is not kept forever', async () => {
  // The bound on the retention set is expiry, not a count. An installation
  // token cannot be refreshed, so once it is past `expires_at` GitHub rejects
  // it and it has stopped being a secret worth holding.
  const r = await rig();
  const start = Date.now();
  r.setNow(start);
  const issued = rotatingTokens(r, start + 60_000);

  await r.adapter.getIssue(ISSUE);
  const early = issued[0];

  // Well past every issued token's expiry; the next mint prunes.
  r.setNow(start + 24 * 3_600_000);
  await r.adapter.getIssue(ISSUE);
  assert.ok(issued.length >= 2, 'the expired token was replaced');

  r.fake.on('GET /repos/anima-research/rayforce/issues/7', {
    status: 422,
    body: { message: `stale ${early} and current ${issued[issued.length - 1]}` },
  });
  const err = await r.adapter.getIssue(ISSUE).then(
    () => null,
    (e: unknown) => e as GitHubApiError,
  );
  assert.ok(err instanceof GitHubApiError);
  // What can still authenticate is still scrubbed...
  assert.ok(
    !err.githubMessage.includes(issued[issued.length - 1]),
    'a credential that still works must stay redacted',
  );
  // ...and what cannot is no longer carried, which is what keeps the set small.
  assert.ok(
    err.githubMessage.includes(early),
    'a long-expired token is not retained; expiry is what bounds the set',
  );
});
