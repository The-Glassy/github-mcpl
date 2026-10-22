/**
 * Owned-repository poll (contributor mode, GITHUB_OWNED_REPO_POLL=auto).
 *
 * The notifications poller lists only the threads the token's user takes
 * part in, so an issue or pull request someone else opens in a repository the
 * user owns never reaches it unless the user is mentioned there or asked to
 * review. For the repositories in GITHUB_REPOS that the user administers or
 * maintains, this runs App mode's repository poll (poller.ts) in its
 * `arrivals` scope: openings, reopens and conversation comments by anyone
 * else, read from the repository since its cursor.
 *
 * **Which repositories.** Each is asked once at start and again an hour after
 * its last answer (`GET /repos/{owner}/{repo}`, whose `permissions` GitHub
 * fills for the token's user). A failed read keeps the last answer, and a
 * repository never answered for counts as not administered; either is asked
 * again on the next pass.
 *
 * **When.** The notifications poller calls {@link OwnedRepoPoll.pollOnce} at
 * the end of each of its passes that met no rate limit, so the two never run
 * at once. Both key what they deliver as `<kind>:<id>:<updated_at>` in one
 * dedup ring, and each reads the ring when its pass starts, so a row both
 * see is delivered once.
 *
 * **Durable state.** The repository poll's own: the cursor `lastPollAt`,
 * which contributor mode has no other use for, and each thread's marker in
 * the head memory under its bare channel id (the notifications poller's
 * cursors are under `notif:`). A first start reads from one interval back.
 */

import { Poller, type IngressState, type PollerApi, type PollResult } from './poller.js';
import { repoSlug, silentLogger, type Logger, type RepoRef } from './types.js';
import type { EventListener } from './webhook.js';

/** How long an answer about a repository's permissions stands. */
export const OWNED_REPO_RECHECK_MS = 60 * 60_000;

export type OwnedRepoApi = PollerApi & {
  /** Whether the token's user administers or maintains `repo`. Throws when GitHub doesn't answer. */
  repoAdministered(repo: RepoRef): Promise<boolean>;
};

export interface OwnedRepoPollOptions {
  api: OwnedRepoApi;
  /** GITHUB_REPOS: the repositories asked about. Only those administered are polled. */
  repos: readonly RepoRef[];
  /** The token's login: its own openings and comments are left out. */
  login: string;
  state: IngressState;
  /** The notifications poller's interval: where a first start's cursor begins. */
  intervalMs: number;
  onEvent: EventListener;
  logger?: Logger;
  /** Overridable in tests. */
  now?: () => Date;
  recheckMs?: number;
}

export class OwnedRepoPoll {
  private readonly api: OwnedRepoApi;
  private readonly repos: readonly RepoRef[];
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly recheckMs: number;
  private readonly poller: Poller;
  /** Each repository's last answer, and when it came, by slug. */
  private readonly answers = new Map<string, { administered: boolean; at: number }>();
  /** The polled set as last logged, so a change is logged once. */
  private logged: string | null = null;

  constructor(opts: OwnedRepoPollOptions) {
    this.api = opts.api;
    this.repos = opts.repos;
    this.logger = opts.logger ?? silentLogger();
    this.now = opts.now ?? (() => new Date());
    this.recheckMs = opts.recheckMs ?? OWNED_REPO_RECHECK_MS;
    this.poller = new Poller({
      api: opts.api,
      repos: [],
      scope: 'arrivals',
      login: opts.login,
      state: opts.state,
      intervalMs: opts.intervalMs,
      onEvent: opts.onEvent,
      logger: this.logger,
      now: this.now,
    });
  }

  /** The repositories the last pass polled. */
  get polled(): RepoRef[] {
    return this.repos.filter((repo) => this.answers.get(repoSlug(repo))?.administered === true);
  }

  /**
   * Refresh the answers that are due, then run one repository-poll pass over
   * the administered repositories. The pass runs with none as well, so the
   * cursor keeps up and a repository that becomes administered starts from
   * now rather than from whenever the last one stopped.
   */
  async pollOnce(): Promise<PollResult> {
    await this.refresh();
    const polled = this.polled;
    this.poller.setRepos(polled);
    const slugs = polled.map(repoSlug);
    if (slugs.join(',') !== this.logged) {
      this.logged = slugs.join(',');
      this.logger.info('owned-repo poll: repositories in GITHUB_REPOS the token user administers or maintains', { repos: slugs });
    }
    const result = await this.poller.pollOnce();
    if (result.delivered.length > 0 || result.failed > 0) {
      this.logger.info('owned-repo poll: pass done', {
        delivered: result.delivered.length,
        duplicates: result.duplicates,
        failed: result.failed,
      });
    }
    return result;
  }

  private async refresh(): Promise<void> {
    const now = this.now().getTime();
    for (const repo of this.repos) {
      const slug = repoSlug(repo);
      const known = this.answers.get(slug);
      if (known !== undefined && now - known.at < this.recheckMs) continue;
      try {
        this.answers.set(slug, { administered: await this.api.repoAdministered(repo), at: now });
      } catch (err) {
        this.logger.warn('owned-repo poll: reading a repository\'s permissions failed; the last answer stands and it is asked again next pass', {
          repo: slug,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
