#!/usr/bin/env node
/**
 * Catch the registration code of GitHub's App-manifest flow.
 *
 * After you submit the manifest form, GitHub creates the App and redirects
 * your browser to the manifest's `redirect_url` — `http://localhost:8723/
 * manifest-callback?code=…`. That code is good for one hour, cannot be
 * re-issued, and is the only thing that can fetch the App's private key and
 * webhook secret. This listens for that one redirect, prints the code on
 * stdout and exits; see README.md, "Create the GitHub App from the manifest".
 *
 *   CODE=$(node deploy/capture-manifest-code.mjs)   # then submit the form
 *
 * The code goes to stdout and nothing else does, so the command substitution
 * above is all you need; progress and errors go to stderr. Loopback only —
 * nothing outside this machine can reach it or read the code out of it.
 *
 * Usage: node capture-manifest-code.mjs [port]     (default 8723, as in
 * app-manifest.json; change both together if 8723 is taken.)
 */

import { createServer } from 'node:http';

const port = Number(process.argv[2] ?? process.env.GITHUB_MCPL_CALLBACK_PORT ?? 8723);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`capture-manifest-code: "${process.argv[2]}" is not a port\n`);
  process.exit(2);
}

const server = createServer((req, res) => {
  const code = new URL(req.url ?? '/', `http://localhost:${port}`).searchParams.get('code');
  res.writeHead(code ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(
    code
      ? 'Code captured. You can close this tab and go back to the terminal.\n'
      : 'No ?code= in this request — this is the GitHub App manifest callback.\n',
    () => {
      if (!code) return;
      // stdout: the one thing a caller wants to capture.
      console.log(code);
      process.exit(0);
    },
  );
});

server.listen(port, '127.0.0.1', () => {
  // The bound port, not the asked-for one: `0` means "any free port", and
  // then this line is the only way to know which.
  const bound = server.address();
  const shown = typeof bound === 'object' && bound ? bound.port : port;
  process.stderr.write(
    `capture-manifest-code: waiting for GitHub's redirect on ` +
      `http://localhost:${shown}/manifest-callback — submit the manifest form now.\n`,
  );
});

server.on('error', (err) => {
  process.stderr.write(`capture-manifest-code: cannot listen on ${port}: ${err.message}\n`);
  process.exit(1);
});
