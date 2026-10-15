/**
 * WP8 operator surface: the manifest, the recipes and the deploy files are
 * data a reader follows literally, so they are checked like code.
 *
 * Three things this proves, one per acceptance criterion of TASK-SRHKG.1.8:
 *   1. app-manifest.json carries GitHub's manifest fields, exactly the five
 *      permissions the tools need, and no OAuth user flow.
 *   2. Both example recipes parse, and every wake policy references only
 *      metadata keys and tags the frozen contract defines (the key list is
 *      `satisfies readonly (keyof EventMetadata)[]`, so a key the contract
 *      drops becomes a type error here, not a silent dead policy).
 *   3. Nothing in the operator surface contains secret material.
 */

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  CORE_TAGS,
  ENV_VARS,
  FEATURE_SETS,
  GITHUB_TAGS,
  type EventMetadata,
} from '../src/types.js';

const root = (rel: string): string => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const text = (rel: string): string => readFileSync(root(rel), 'utf8');
const json = (rel: string): any => JSON.parse(text(rel));

/**
 * The booleans a host may name in `metadataTrue`. Typed against the contract:
 * renaming one in types.ts fails the typecheck here.
 */
const METADATA_BOOLEANS = [
  'mentioned',
  'isOwnThread',
  'isReplyToSelf',
  'isReviewRequested',
  'isCiFailure',
  'fromSelf',
  'isMaintainer',
] as const satisfies readonly (keyof EventMetadata)[];

const KNOWN_TAGS: readonly string[] = [...CORE_TAGS, ...GITHUB_TAGS];
const RECIPES = ['examples/recipe-maintainer-clone.json', 'examples/recipe-contributor.json'];

// ─── 1. the App manifest ─────────────────────────────────────────────────────

test('app-manifest.json lists exactly the permissions the tools need', () => {
  const m = json('app-manifest.json');
  assert.deepEqual(m.default_permissions, {
    issues: 'write',
    pull_requests: 'write',
    contents: 'read',
    checks: 'read',
    metadata: 'read',
  });
});

test('app-manifest.json subscribes the events the ingress understands', () => {
  const m = json('app-manifest.json');
  assert.deepEqual(m.default_events, [
    'issues',
    'issue_comment',
    'pull_request',
    'pull_request_review',
    'pull_request_review_comment',
    'check_suite',
    'check_run',
    'push',
  ]);
});

test('app-manifest.json: active webhook, placeholder URL, no OAuth user flow', () => {
  const m = json('app-manifest.json');
  assert.equal(typeof m.name, 'string');
  assert.equal(m.public, false);
  assert.equal(m.hook_attributes.active, true);
  assert.match(m.hook_attributes.url, /^https:\/\//);
  // A placeholder, never a real host: the operator fills it in.
  assert.match(m.hook_attributes.url, /example\.com$|REPLACE/i);
  // `redirect_url` is the manifest flow's *registration* redirect: GitHub
  // sends the one-hour conversion code there once the App exists, and
  // without it that code is lost and the operator falls back to generating
  // the key and the secret by hand. It is not OAuth — user authorization is
  // `callback_urls` plus `request_oauth_on_install`, and this App has
  // neither, so it only ever acts as itself.
  assert.equal(m.request_oauth_on_install, false);
  assert.equal(m.callback_urls, undefined);
  assert.match(m.redirect_url, /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//,
    'the conversion code must come back to the operator\'s own machine, not to a third party');
  // Every key GitHub's manifest schema does not define would be ignored
  // silently, so the manifest stays inside the documented field set.
  const allowed = new Set([
    'name',
    'description',
    'url',
    'public',
    'hook_attributes',
    'redirect_url',
    'request_oauth_on_install',
    'setup_on_update',
    'default_permissions',
    'default_events',
  ]);
  for (const key of Object.keys(m)) assert.ok(allowed.has(key), `unknown manifest field: ${key}`);
});

// ─── 2. the example recipes ──────────────────────────────────────────────────

for (const rel of RECIPES) {
  test(`${rel} parses and names github-mcpl over stdio`, () => {
    const recipe = json(rel);
    assert.equal(typeof recipe.name, 'string');
    assert.ok(recipe.agent, 'a recipe needs an agent');
    const server = recipe.mcpServers.github;
    assert.ok(server, 'the server entry is mcpServers.github, which wake policies match as source "github"');
    assert.ok(server.args.includes('--stdio'));
    for (const name of Object.keys(server.env ?? {})) {
      assert.ok((ENV_VARS as readonly string[]).includes(name), `unknown variable ${name}`);
    }
    for (const fs of server.enabledFeatureSets) {
      assert.ok((FEATURE_SETS as readonly string[]).includes(fs), `unknown feature set ${fs}`);
    }
  });

  test(`${rel} wake policies reference only contract metadata and tags`, () => {
    const policies = json(rel).modules.wake.policies as Array<{
      name: string;
      match: Record<string, unknown>;
      behavior: unknown;
    }>;
    assert.ok(policies.length > 0);
    for (const policy of policies) {
      const match = policy.match as {
        source?: string;
        metadataTrue?: string[];
        tagsAny?: string[];
        tagsAll?: string[];
        tagsNone?: string[];
      };
      assert.equal(match.source, 'github', `${policy.name}: policies here match this server only`);
      for (const key of match.metadataTrue ?? []) {
        assert.ok(
          (METADATA_BOOLEANS as readonly string[]).includes(key),
          `${policy.name}: ${key} is not a metadata boolean the contract defines`,
        );
      }
      for (const tag of [...(match.tagsAny ?? []), ...(match.tagsAll ?? []), ...(match.tagsNone ?? [])]) {
        assert.ok(KNOWN_TAGS.includes(tag), `${policy.name}: ${tag} is not a tag the contract defines`);
      }
    }
  });

  test(`${rel} skips the agent's own actions before anything else`, () => {
    // Without this first, `isOwnThread` wakes the agent on its own comment.
    const first = json(rel).modules.wake.policies[0];
    assert.deepEqual(first.match.metadataTrue, ['fromSelf']);
    assert.equal(first.behavior, 'skip');
    assert.equal(json(rel).modules.wake.default, 'skip');
  });
}

test('recipe-maintainer-clone.json debounces newly opened issues and pull requests', () => {
  const policies = json('examples/recipe-maintainer-clone.json').modules.wake.policies;
  const debounced = policies.find((p: any) => typeof p.behavior === 'object' && 'debounce' in p.behavior);
  assert.ok(debounced, 'a burst of new threads must not be one wake each');
  assert.equal(debounced.behavior.debounce, 60000);
  assert.deepEqual(debounced.match.tagsAny, ['github:issue=opened', 'github:pr=opened']);
});

// ─── 3. the deploy files, and no secrets anywhere ────────────────────────────

test('the systemd unit runs the launcher as a non-root user, nothing secret inline', () => {
  const unit = text('deploy/github-mcpl.service');
  assert.match(unit, /^User=(?!root$)\S+$/m);
  assert.match(unit, /^ExecStart=\S*\/deploy\/github-mcpl --tcp \d+$/m);
  // A secret in the unit is readable through `systemctl show`.
  assert.doesNotMatch(unit, /^Environment=.*(SECRET|KEY|TOKEN)/m);
});

test('the operator surface carries no secret material', () => {
  const files = [
    'README.md',
    'app-manifest.json',
    'docs/deploy.md',
    'deploy/github-mcpl.service',
    'deploy/github-mcpl.env.example',
    'deploy/github-mcpl',
    'deploy/capture-manifest-code.mjs',
    // The tests too: a fixture is the classic place a real key gets pasted.
    'test/wp8-docs.test.ts',
    'test/wp8-policies.test.ts',
    ...RECIPES,
  ];
  // Private keys, GitHub token forms, and an installation id pasted into a URL.
  const forbidden = [/-----BEGIN [A-Z ]*PRIVATE KEY/, /\bgh[pousr]_[A-Za-z0-9]{16,}/, /\bv1\.[0-9a-f]{40}\b/];
  for (const rel of files) {
    const body = text(rel);
    for (const pattern of forbidden) {
      assert.doesNotMatch(body, pattern, `${rel} looks like it carries secret material`);
    }
  }
  // Every example and deploy file is covered by the list above.
  for (const dir of ['examples', 'deploy']) {
    for (const name of readdirSync(root(dir))) {
      assert.ok(files.includes(`${dir}/${name}`), `${dir}/${name} is not checked for secrets`);
    }
  }
});

// ─── 4. the install path, as a reader runs it ────────────────────────────────
//
// Review round 2 found three defects that only running the documented
// commands reveals: a `node -e` listener the shell would not parse, a
// credential split that wrote into a root-owned directory as the service
// user, and deploy steps that emptied the credentials the README had just
// written. So the commands are extracted from the prose and run.

/** The one fenced `sh` block of `rel` that contains `needle`, verbatim. */
function shellBlock(rel: string, needle: string): string {
  const blocks = [...text(rel).matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]);
  const found = blocks.filter((b) => b.includes(needle));
  assert.equal(found.length, 1, `${rel}: expected one sh block containing "${needle}", found ${found.length}`);
  return found[0];
}

/**
 * Run a documented block as written, with HOME pointed at a temp dir: the
 * whole setup is unprivileged and lives under ~, so nothing is substituted.
 */
function sh(script: string, home: string, env: Record<string, string> = {}): { stdout: string; stderr: string } {
  const r = spawnSync('sh', ['-e', '-u', '-c', script], {
    cwd: home,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...env },
  });
  assert.equal(r.status, 0, `the documented commands failed:\n${r.stderr}`);
  return { stdout: r.stdout, stderr: r.stderr };
}

const modeOf = (path: string): string => (statSync(path).mode & 0o777).toString(8);

/** A temp home with ~/.config/github-mcpl as README step 2 leaves it. */
function freshHome(): { home: string; cfg: string } {
  const home = mkdtempSync(join(tmpdir(), 'wp8-home-'));
  const cfg = join(home, '.config/github-mcpl');
  mkdirSync(cfg, { recursive: true, mode: 0o700 });
  return { home, cfg };
}

/** The `sh` blocks of "Setup, in order", in the order a reader meets them. */
function setupBlocks(): string[] {
  const readme = text('README.md');
  const section = readme.slice(readme.indexOf('## Setup, in order'), readme.indexOf('## Plain-MCP mode'));
  return [...section.matchAll(/```sh\n([\s\S]*?)```/g)].map((m) => m[1]);
}

test('README: the setup never asks for sudo', () => {
  // The server runs as the agent's own user; a sudo here would put a file
  // where that user cannot read it.
  for (const block of setupBlocks()) {
    const commands = block.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    assert.doesNotMatch(commands, /\bsudo\b/, `a setup step uses sudo:\n${block}`);
  }
});

test('README: the manifest-callback listener parses and captures a code', async () => {
  // a. the README points at a script file, not at a shell-quoted one-liner
  //    (round 2: the backslashes in `node -e '…'` reached Node as JavaScript
  //    and it exited 1 with a SyntaxError before ever listening).
  const block = shellBlock('README.md', 'capture-manifest-code.mjs');
  assert.doesNotMatch(block, /node +-e/, 'a one-liner here is a quoting accident waiting to happen');
  assert.match(block, /CODE=\$\(node deploy\/capture-manifest-code\.mjs\)/);

  const script = root('deploy/capture-manifest-code.mjs');
  assert.ok(existsSync(script), 'the script the README names exists');

  // b. it is valid JavaScript
  const checked = spawnSync(process.execPath, ['--check', script], { encoding: 'utf8' });
  assert.equal(checked.status, 0, `node --check failed:\n${checked.stderr}`);

  // c. it really catches a redirect and prints the code on stdout, alone
  const child = spawn(process.execPath, [script, '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    // The script reports the port it actually bound, which is how `0` works.
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no listen line; stderr was: ${stderr}`)), 10_000);
      child.stderr.on('data', () => {
        const m = /http:\/\/localhost:(\d+)\/manifest-callback/.exec(stderr);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
      child.once('exit', (code) => reject(new Error(`exited ${code} before listening: ${stderr}`)));
    });

    const res = await fetch(`http://localhost:${port}/manifest-callback?code=test-code-123&state=x`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /close this tab/i);

    const exit = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    assert.equal(exit, 0);
    assert.equal(stdout.trim(), 'test-code-123', 'stdout carries the code and nothing else');
  } finally {
    child.kill();
  }
});

test('README: the credential split creates both files at mode 600', () => {
  const block = shellBlock('README.md', 'app-manifests');
  const { home, cfg } = freshHome();
  try {
    const pem = ['-----BEGIN TEST PLACEHOLDER-----', 'not-a-key', '-----END TEST PLACEHOLDER-----'].join('\n');
    const fixture = join(home, 'conversion-fixture.json');
    writeFileSync(fixture, JSON.stringify({
      id: 987654,
      slug: 'rayforce-clone',
      pem,
      webhook_secret: 'not-a-real-secret',
      client_id: 'Iv1.unused',
      client_secret: 'unused',
    }));

    // The one thing that cannot run here is the network call; the fixture
    // stands in for GitHub's answer, and the pipeline around it is verbatim.
    const offline = block.replace(/curl[\s\S]*?app-manifests[^\n]*\\\n/, 'cat "$CONVERSION_FIXTURE" \\\n');
    assert.ok(!offline.includes('curl'), 'the network call is the only command replaced');

    const { stdout } = sh(offline, home, { CONVERSION_FIXTURE: fixture });

    assert.equal(readFileSync(join(cfg, 'app-private-key.pem'), 'utf8'), `${pem}\n`,
      'the PEM survives the split with its newlines');
    assert.equal(readFileSync(join(cfg, 'webhook-secret'), 'utf8'), 'not-a-real-secret\n');
    assert.equal(modeOf(join(cfg, 'app-private-key.pem')), '600');
    assert.equal(modeOf(join(cfg, 'webhook-secret')), '600');
    assert.ok(!existsSync(join(cfg, 'conversion.json')), 'the response is deleted, key and all');
    assert.match(stdout, /^GITHUB_APP_ID=987654$/m);
    assert.match(stdout, /^GITHUB_BOT_LOGIN=rayforce-clone\[bot\]$/m);
    assert.doesNotMatch(stdout, /PLACEHOLDER|not-a-real-secret/, 'no secret is printed to a terminal');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// Round 2: `install /dev/null` ran unconditionally, so a reader who followed
// the README's registration and then the manual steps ended with an empty
// PEM — which readConfig rejects, after the code is long expired.
for (const [label, rel] of [['docs/deploy.md', 'docs/deploy.md'], ['README path B', 'README.md']] as const) {
  /** The guarded creation alone: the fill commands need a key and a terminal. */
  const guarded = (): string =>
    shellBlock(rel, '[ -e "$f" ]')
      .replace(/^> ?/gm, '')
      .replace(/^(cat|shred)[^\n]*$/gm, ':');

  test(`${label}: manual setup never empties a credential file that exists`, () => {
    const { home, cfg } = freshHome();
    try {
      writeFileSync(join(cfg, 'app-private-key.pem'), 'EXISTING KEY\n', { mode: 0o600 });
      writeFileSync(join(cfg, 'webhook-secret'), 'EXISTING SECRET\n', { mode: 0o600 });
      sh(guarded(), home);
      assert.equal(readFileSync(join(cfg, 'app-private-key.pem'), 'utf8'), 'EXISTING KEY\n');
      assert.equal(readFileSync(join(cfg, 'webhook-secret'), 'utf8'), 'EXISTING SECRET\n');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test(`${label}: manual setup creates the credential files it finds missing, at 600`, () => {
    const { home, cfg } = freshHome();
    try {
      sh(guarded(), home);
      for (const f of ['app-private-key.pem', 'webhook-secret']) {
        assert.equal(readFileSync(join(cfg, f), 'utf8'), '', `${f} starts empty`);
        assert.equal(modeOf(join(cfg, f)), '600', `${f} is 600 before it holds anything`);
      }
      assert.equal(modeOf(cfg), '700', 'the directory stays 700');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
}

// ─── 5. the launcher ─────────────────────────────────────────────────────────

test('deploy/github-mcpl loads the env file and starts this checkout with the named Node', () => {
  const { home, cfg } = freshHome();
  try {
    // A stand-in Node that reports what it was given, on stderr like the server.
    const fakeNode = join(home, 'fake-node');
    writeFileSync(fakeNode, '#!/bin/sh\necho "entry=$1 arg=$2 key=$GITHUB_APP_PRIVATE_KEY_FILE id=$GITHUB_APP_ID" >&2\n', { mode: 0o755 });
    writeFileSync(join(cfg, 'github-mcpl.env'), [
      `GITHUB_MCPL_NODE=${fakeNode}`,
      'GITHUB_APP_ID=987654',
      'GITHUB_APP_PRIVATE_KEY_FILE=$HOME/.config/github-mcpl/app-private-key.pem',
      '',
    ].join('\n'), { mode: 0o600 });

    const r = spawnSync(root('deploy/github-mcpl'), ['--stdio'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: home },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '', 'stdout is the JSON-RPC channel: the launcher prints nothing on it');
    assert.equal(
      r.stderr.trim(),
      `entry=${root('dist/src/index.js')} arg=--stdio key=${home}/.config/github-mcpl/app-private-key.pem id=987654`,
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('deploy/github-mcpl without an env file fails on stderr, not stdout', () => {
  const { home } = freshHome();
  try {
    const r = spawnSync(root('deploy/github-mcpl'), ['--stdio'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', HOME: home },
    });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /cannot read .*github-mcpl\.env/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ─── 6. the setup sequence on a host that has nothing yet ────────────────────

test('README: the checkout exists before a step runs something out of it', () => {
  // Round 3: step 3b did `cd` into the checkout while the clone was in step 7,
  // so on a clean host registration failed with "No such file or directory"
  // — and cloning early by hand then broke the later clone.
  const blocks = setupBlocks();
  const clones = blocks.filter((b) => /git clone/.test(b));
  assert.equal(clones.length, 1, 'exactly one clone in the setup, or the second one fails');

  const cloneAt = blocks.findIndex((b) => /git clone/.test(b));
  const firstUse = blocks.findIndex((b) => /cd ~\/github-mcpl|node (deploy|dist)\//.test(b));
  assert.ok(cloneAt >= 0 && firstUse >= 0);
  assert.ok(cloneAt <= firstUse, `the clone (block ${cloneAt}) must not come after block ${firstUse}`);

  // And nothing else clones over it.
  assert.doesNotMatch(text('docs/deploy.md'), /git clone/,
    'docs/deploy.md builds the checkout README step 1 made');
});

test('README: an empty host reaches the registration script by following step 1', () => {
  const home = mkdtempSync(join(tmpdir(), 'wp8-host-'));
  try {
    const step1 = setupBlocks().find((b) => /git clone/.test(b));
    assert.ok(step1, 'step 1 clones');

    // The documented commands, with the placeholder source pointed at this
    // checkout (nothing here reaches the network). `node --version` runs as written.
    sh(step1.replace('<this repository>', root('.')), home);

    const checkout = join(home, 'github-mcpl');
    // Step 3b is `cd ~/github-mcpl` then `node deploy/capture-manifest-code.mjs`:
    // on a host with nothing on it, that command has to resolve.
    assert.ok(existsSync(join(checkout, 'deploy/capture-manifest-code.mjs')),
      'the registration script is in the fresh clone');
    const checked = spawnSync(process.execPath, ['--check', 'deploy/capture-manifest-code.mjs'], {
      cwd: checkout,
      encoding: 'utf8',
    });
    assert.equal(checked.status, 0, `node --check failed in the clone:\n${checked.stderr}`);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
