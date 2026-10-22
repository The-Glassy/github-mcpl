- **Owned repositories in contributor mode:** `GITHUB_OWNED_REPO_POLL` (default `auto`) runs App mode's
  repository poll over the repositories in `GITHUB_REPOS` that the token's user administers or maintains,
  checked at start and hourly. It delivers issues and pull requests that others open or reopen, and
  conversation comments that others post, which the notifications listing (`participating=true`) never
  shows on threads the user isn't part of. It runs at the end of each notifications pass and shares that
  pass's dedup ring, so a row both paths see arrives once. `off` turns it off.
- **App mode's repository poll** no longer moves its cursor past rows a list cut at its 300-row cap: it stops a
  second before the last row it got, and the rest arrive on the next pass.
