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
 * fills for the token's user). A failed read keeps the last answer and is
 * asked again on the next pass. While a repository has never been answered
 * for, or GitHub rate-limits a read, no pass runs, so the cursor waits
 * rather than moving past that repository's rows unread.
 *
 * **When.** The notifications poller calls {@link OwnedRepoPoll.pollOnce} at
 * the end of each of its passes that met no rate limit, so the two never run
 * at once. Both key what they deliver as `<kind>:<id>:<updated_at>` in one
 * dedup ring, and each reads the ring when its pass starts, so a row both
 * see is delivered once.
 *
 * **State.** The repository poll's cursor `lastPollAt`, durable, which
 * contributor mode has no other use for, and each closed thread's marker in
 * memory (poller.ts `ARRIVALS_MARKER_MEMORY`), apart from the 200-entry head
 * memory that holds the notifications poller's thread cursors, so a restart
 * forgets which threads were closed. A first start's cursor is one interval
 * before the start, stored at once, so a pass that fails doesn't move it.
 */

import { isLastingFailure, isRateLimit } from './github-adapter.js';
import { Poller, type IngressState, type PollerApi } from './poller.js';
import { MIN_POLL_INTERVAL_MS, repoSlug, silentLogger, type Logger, type NormalizedEvent, type RepoRef } from './types.js';
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
    if (opts.state.lastPollAt() === null) {
      const since = new Date(this.now().getTime() - Math.max(MIN_POLL_INTERVAL_MS, opts.intervalMs)).toISOString();
      opts.state.setLastPollAt(since);
      this.logger.info('owned-repo poll: no stored cursor, so delivery begins one interval before this start', { since });
    }
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
  async pollOnce(seen?: ReadonlySet<string>): Promise<{ delivered: NormalizedEvent[]; duplicates: number; ran: boolean }> {
    if (!(await this.refresh())) return { delivered: [], duplicates: 0, ran: false };
    const polled = this.polled;
    this.poller.setRepos(polled);
    const slugs = polled.map(repoSlug);
    if (slugs.join(',') !== this.logged) {
      this.logged = slugs.join(',');
      this.logger.info('owned-repo poll: repositories in GITHUB_REPOS the token user administers or maintains', { repos: slugs });
    }
    const result = await this.poller.pollOnce(seen);
    if (result.delivered.length > 0 || result.failed > 0) {
      this.logger.info('owned-repo poll: pass done', {
        delivered: result.delivered.length,
        duplicates: result.duplicates,
        failed: result.failed,
      });
    }
    return { delivered: result.delivered, duplicates: result.duplicates, ran: true };
  }

  /** Ask about the repositories that are due. False when a pass mustn't run: one was never answered for, or GitHub rate-limited a read. */
  private async refresh(): Promise<boolean> {
    const now = this.now().getTime();
    for (const repo of this.repos) {
      const slug = repoSlug(repo);
      const known = this.answers.get(slug);
      if (known !== undefined && now - known.at < this.recheckMs) continue;
      try {
        this.answers.set(slug, { administered: await this.api.repoAdministered(repo), at: now });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        if (isLastingFailure(err)) {
          // Gone or out of the token's reach: nothing there to poll.
          this.answers.set(slug, { administered: false, at: now });
          this.logger.warn('owned-repo poll: a repository is gone or out of the token\'s reach, so it is not polled', { repo: slug, error });
          continue;
        }
        if (isRateLimit(err)) {
          this.logger.warn('owned-repo poll: GitHub rate-limited a permissions read, so this pass polls nothing', { repo: slug, error });
          return false;
        }
        this.logger.warn('owned-repo poll: reading a repository\'s permissions failed; the last answer stands and it is asked again next pass', {
          repo: slug,
          error,
        });
      }
    }
    const unanswered = this.repos.filter((repo) => !this.answers.has(repoSlug(repo))).map(repoSlug);
    if (unanswered.length > 0) {
      this.logger.warn('owned-repo poll: some repositories were never answered for, so this pass polls nothing and the cursor waits', {
        repos: unanswered,
      });
      return false;
    }
    return true;
  }
}
