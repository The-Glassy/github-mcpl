- `GITHUB_REPOS` accepts several repositories, as long as they share one
  owner (one App installation, one token); a second owner is a second server
  process, and a duplicate entry is a startup error. With several
  repositories the tools' `repo` argument and the repository half of `thread`
  are required instead of defaulting, so a call can never land in the wrong
  one.
- `GITHUB_PR_BASE_ALLOW` entries can be scoped: `branch` applies to every
  repository, `owner/name:branch` to that one (`anima-research/rayforce:dev,main`).
  A scoped entry naming a repository outside `GITHUB_REPOS` is refused at
  startup; a refusal names the branches allowed on that repository.
