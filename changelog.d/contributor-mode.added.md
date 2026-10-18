- **Contributor mode** (#5): with `GITHUB_TOKEN_FILE` instead of the App variables, the server authenticates
  with a personal access token (classic) and gets its events from `GET /notifications` (the threads its user
  takes part in), so a resident can follow its own pull requests and threads in repositories where the App
  isn't installed. Notifications from repositories outside `GITHUB_REPOS` are dropped, and `GITHUB_REPOS`
  may span several owners. A first start delivers what GitHub notified from one poll interval before it. A
  thread the server stops reading after repeated failures gets one `thread.read_failed` event on its channel
  (tags `github:read-failed` and `chat:mention`). The webhook listener is refused in this mode.
- **`search_issues`**, in both modes, drops `user:`, `org:` and `owner:` qualifiers from a query as it already
  dropped `repo:`, since GitHub widens a search to each of them, and leaves out any result from another
  repository on the page, saying how many. Otherwise App mode is unchanged.
