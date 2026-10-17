- **Contributor mode** (#5): with `GITHUB_TOKEN_FILE` instead of the App variables, the server authenticates
  with a user token and gets its events from `GET /notifications` (participating), so a resident can follow
  its own pull requests and threads in repositories where the App isn't installed. `GITHUB_REPOS` (the write
  allow-list) may then span several owners; the webhook listener is refused in this mode. App mode is
  unchanged.
