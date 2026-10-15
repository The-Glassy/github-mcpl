/**
 * `github.comments` — the rollback-capable write tools (TASK-SRHKG.1.7).
 *
 * The contract's feature-set bullet: `comment`, `reply_in_thread`,
 * `edit_own_comment`, `delete_own_comment`, `upsert_sticky_comment`. Every one
 * of them refuses a repository outside GITHUB_REPOS by name, and every write
 * records into {@link GithubState} under the current checkpoint and flushes, so
 * {@link rollbackComments} can undo it after a restart as well as before one.
 *
 * Two arguments the contract names but does not shape, decided here and
 * reported for .9 to reconcile:
 *
 *   - **`thread`** accepts `{ owner?, name?, number, kind? }` or the string
 *     forms `owner/name#12`, `github:owner/name#12`, `#12`, `12`. Owner and
 *     name default to the single entry of GITHUB_REPOS (v1 accepts exactly
 *     one); `kind` defaults to `issue`, which is also the REST path issue
 *     comments take on a pull request.
 *   - **`edit_own_comment` and `delete_own_comment` take `thread` as well as
 *     `commentId`, and an optional `review`.** `GitHubApi` has no
 *     `getComment`, so the only way to check that the author is the bot — the
 *     refusal the contract demands — is to list the thread's comments and find
 *     it there. Issue comments and review comments are numbered separately, so
 *     `review` names the endpoint; omitted, an id that exists on both is
 *     refused rather than guessed at.
 *
 * Tool results are plain text blocks bounded by {@link LIMITS}; .4's
 * `content.ts` does not exist on `main` yet, so nothing here imports it.
 */

import {
  ERR_CHECKPOINT_NOT_FOUND,
  textContent,
  type StateRollbackParams,
  type StateRollbackResult,
} from '@animalabs/mcpl-core';
import { McplRpcError } from './errors.js';
import { THREAD_PROPERTY, parseThread, type Parsed } from './tool-support.js';
import type { GithubStateStore, ThreadLocator } from './state.js';
import {
  COMMENTS_FEATURE_SET,
  LIMITS,
  TOOL_COMMENT,
  TOOL_DELETE_OWN_COMMENT,
  TOOL_EDIT_OWN_COMMENT,
  TOOL_REPLY_IN_THREAD,
  TOOL_UPSERT_STICKY_COMMENT,
  bounded,
  parseRepoSlug,
  parseThreadId,
  repoAllowed,
  repoSlug,
  type Comment,
  type RepoRef,
  type ThreadKind,
  type ThreadRef,
  type ToolContext,
  type ToolDefinition,
  type ToolModule,
  type ToolResult,
} from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Argument parsing
// ─────────────────────────────────────────────────────────────────────────────

/** A refusal: the message the tool answers with, as a text block. */
function refuse(message: string): ToolResult {
  return { content: [textContent(message)], isError: true };
}

function ok(message: string): ToolResult {
  return { content: [textContent(bounded(message, LIMITS.commentChars))] };
}

/**
 * `thread` is parsed by {@link parseThread} in `tool-support.ts` — WP9 made it
 * the one parser for every form both tool families accept, so .6's `repo`
 * plus `number` and .7's single `thread` cannot drift apart.
 */
function parseThreadArg(raw: unknown, ctx: ToolContext, kindDefault: ThreadKind = 'issue'): Parsed<ThreadRef> {
  return parseThread(raw, ctx, kindDefault);
}

function parseBody(raw: unknown, field = 'body'): Parsed<string> {
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, error: `${field}: required, a non-empty string` };
  return { ok: true, value: raw };
}

function parseCommentId(raw: unknown): Parsed<number> {
  const value = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return { ok: false, error: 'commentId: required, a positive integer' };
  }
  return { ok: true, value };
}

/**
 * Which endpoint owns the comment id: `true` review comment, `false` issue
 * comment, absent "look on both and refuse an id that exists on each".
 */
function parseEndpoint(raw: unknown): Parsed<boolean | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== 'boolean') {
    return { ok: false, error: 'review: true for a review comment, false for an issue comment, or omit it' };
  }
  return { ok: true, value: raw };
}

/** The allow-list check every write tool makes, naming the repository. */
function repoRefused(repo: RepoRef, ctx: ToolContext): string | null {
  if (repoAllowed(repo, ctx.repos)) return null;
  return `refused: ${repoSlug(repo)} is not in GITHUB_REPOS (${ctx.repos.map(repoSlug).join(', ') || 'empty'})`;
}

/**
 * The repository of a checkpoint record, or why the undo must not touch it: a
 * record written under one GITHUB_REPOS may be replayed under another (the
 * state file outlives a configuration change), and rollback is a write like
 * any other, so the allow-list binds it exactly as it binds the tools.
 */
function recordRepo(slug: string, ctx: ToolContext): Parsed<RepoRef> {
  const repo = parseRepoSlug(slug);
  if (!repo) return { ok: false, error: `unparsable repository "${slug}" in the checkpoint record` };
  const denied = repoRefused(repo, ctx);
  return denied ? { ok: false, error: denied } : { ok: true, value: repo };
}

/**
 * `ToolContext.state` is `StateStore`, which WP9 widened to carry the delete
 * record and the §8.7 status. What is still only ours is the *plan*
 * `rollback` returns — {@link CommentRollbackPlan} also lists the deletes
 * nothing can undo. One cast, named here rather than scattered.
 */
function store(ctx: Pick<ToolContext, 'state'>): GithubStateStore {
  return ctx.state as GithubStateStore;
}

function locator(thread: ThreadRef): ThreadLocator {
  return { number: thread.number, kind: thread.kind };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sticky markers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The HTML comment a sticky body is recognised by. A bare `marker` ("ci-status")
 * becomes `<!-- ci-status -->`; a marker already written as an HTML comment is
 * kept verbatim, so a recipe may pass either.
 */
export function stickyMarker(marker: string): string {
  const trimmed = marker.trim();
  return /^<!--[\s\S]*-->$/.test(trimmed) ? trimmed : `<!-- ${trimmed} -->`;
}

/** The body to write: the marker is kept, exactly once, at the top. */
export function stickyBody(marker: string, body: string): string {
  const html = stickyMarker(marker);
  return body.includes(html) ? body : `${html}\n${body}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Finding a comment the bot may own
// ─────────────────────────────────────────────────────────────────────────────

/** Where a comment lives, which decides the REST path of an edit or delete. */
interface FoundComment {
  comment: Comment;
  /** True for a review comment (`pulls/comments/{id}`). */
  review: boolean;
}

/**
 * Find `commentId` on `thread`, on the endpoint the caller named.
 *
 * GitHub numbers issue comments (`issues/comments/{id}`) and review comments
 * (`pulls/comments/{id}`) from separate sequences, so one number can name one
 * of each on the same pull request — and `thread.kind` cannot tell them apart,
 * since a pull request carries comments of both kinds. So the endpoint is the
 * caller's to name:
 *
 *   - `review: true` looks only among the review conversations;
 *   - `review: false` only among the issue comments;
 *   - omitted looks on both and, when the id exists on both, refuses and says
 *     so rather than picking one and editing the wrong comment.
 */
async function findComment(
  thread: ThreadRef,
  commentId: number,
  ctx: ToolContext,
  review?: boolean,
): Promise<Parsed<FoundComment>> {
  const where = `${repoSlug(thread.repo)}#${thread.number}`;
  const asIssue = review === true ? null : await findIssueComment(thread, commentId, ctx);
  // An issue has no review conversations, so when the endpoint is left open
  // only a pull request is asked; `review: true` asks regardless of the kind
  // the caller gave. A lookup that fails is not evidence of absence: the
  // endpoint stays unknown and nothing is written (a timeout must never pick
  // the issue comment).
  let asReview: FoundComment | null = null;
  if (review === true || (review === undefined && thread.kind === 'pull')) {
    const lookup = await findReviewComment(thread, commentId, ctx);
    if ('failed' in lookup) {
      return {
        ok: false,
        error:
          `refused: could not establish whether ${commentId} on ${where} is a review comment ` +
          `(${lookup.failed}); retry, or pass review: false for the issue comment`,
      };
    }
    asReview = lookup.found;
  }

  if (asIssue && asReview) {
    return {
      ok: false,
      error:
        `refused: ${commentId} on ${where} names both an issue comment and a review comment; ` +
        'pass review: true for the review comment or review: false for the issue comment',
    };
  }
  const found = asIssue ?? asReview;
  if (found) return { ok: true, value: found };
  const endpoint = review === true ? ' as a review comment' : review === false ? ' as an issue comment' : '';
  return { ok: false, error: `no comment ${commentId} on ${where}${endpoint}` };
}

/** `issues/comments/{id}`: top-level comments, on an issue or a pull request. */
async function findIssueComment(thread: ThreadRef, commentId: number, ctx: ToolContext): Promise<FoundComment | null> {
  const comment = (await ctx.api.listComments(thread)).find((c) => c.id === commentId);
  return comment ? { comment, review: false } : null;
}

/**
 * `pulls/comments/{id}`: comments inside a review conversation. A lookup that
 * throws is reported as `failed`, distinct from an empty answer: the caller
 * decides, and never treats a failure as "not there".
 */
async function findReviewComment(
  thread: ThreadRef,
  commentId: number,
  ctx: ToolContext,
): Promise<{ found: FoundComment | null } | { failed: string }> {
  let threads;
  try {
    threads = await ctx.api.listReviewThreads({ ...thread, kind: 'pull' });
  } catch (err) {
    return { failed: bounded(err instanceof Error ? err.message : String(err), 200) };
  }
  for (const rt of threads) {
    const found = rt.comments.find((c) => c.id === commentId);
    if (!found) continue;
    return {
      found: {
      review: true,
      comment: {
        id: found.id,
        author: found.author,
        body: found.body,
        createdAt: found.createdAt,
        updatedAt: found.updatedAt ?? found.createdAt,
        html_url: `https://github.com/${repoSlug(thread.repo)}/pull/${thread.number}#discussion_r${found.id}`,
        path: rt.path,
        line: rt.line,
        side: rt.side,
        inReplyTo: found.inReplyTo,
      },
      },
    };
  }
  return { found: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// The tools
// ─────────────────────────────────────────────────────────────────────────────

/** The `thread` argument's schema; its parser and its shape live together. */
const THREAD_SCHEMA = THREAD_PROPERTY;

export const COMMENT_TOOLS: ToolDefinition[] = [
  {
    name: TOOL_COMMENT,
    description: 'Post a comment on an issue or pull request.',
    inputSchema: {
      type: 'object',
      properties: { thread: THREAD_SCHEMA, body: { type: 'string', description: 'Markdown body.' } },
      required: ['thread', 'body'],
    },
  },
  {
    name: TOOL_REPLY_IN_THREAD,
    description: 'Reply inside a review conversation on a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        thread: THREAD_SCHEMA,
        threadId: { type: 'string', description: 'The review conversation, "rt:<root review comment id>".' },
        body: { type: 'string', description: 'Markdown body.' },
      },
      required: ['thread', 'threadId', 'body'],
    },
  },
  {
    name: TOOL_EDIT_OWN_COMMENT,
    description: "Edit a comment this bot wrote. Refused for anyone else's comment.",
    inputSchema: {
      type: 'object',
      properties: {
        thread: THREAD_SCHEMA,
        commentId: { type: 'integer', description: 'The comment id.' },
        body: { type: 'string', description: 'The new Markdown body.' },
        review: {
          type: 'boolean',
          description:
            'Which endpoint owns the id: true a review-conversation comment, false a top-level comment. Omit it unless the id names one of each on this thread, which is refused until you say which.',
        },
      },
      required: ['thread', 'commentId', 'body'],
    },
  },
  {
    name: TOOL_DELETE_OWN_COMMENT,
    description: "Delete a comment this bot wrote. Refused for anyone else's comment, and not undoable by rollback.",
    inputSchema: {
      type: 'object',
      properties: {
        thread: THREAD_SCHEMA,
        commentId: { type: 'integer', description: 'The comment id.' },
        review: {
          type: 'boolean',
          description:
            'Which endpoint owns the id: true a review-conversation comment, false a top-level comment. Omit it unless the id names one of each on this thread, which is refused until you say which.',
        },
      },
      required: ['thread', 'commentId'],
    },
  },
  {
    name: TOOL_UPSERT_STICKY_COMMENT,
    description:
      'Create or update one durable comment per marker: edits the bot comment carrying the marker, else posts a new one. The marker stays in the body.',
    inputSchema: {
      type: 'object',
      properties: {
        thread: THREAD_SCHEMA,
        marker: { type: 'string', description: 'A key ("ci-status") or an HTML comment ("<!-- ci-status -->").' },
        body: { type: 'string', description: 'Markdown body; the marker is kept at the top.' },
      },
      required: ['thread', 'marker', 'body'],
    },
  },
];

/** The `github.comments` ToolModule .9 routes `tools/call` to. */
export const commentsToolModule: ToolModule = {
  featureSet: COMMENTS_FEATURE_SET,
  tools: COMMENT_TOOLS,
  call(name, args, ctx) {
    switch (name) {
      case TOOL_COMMENT:
        return comment(args, ctx);
      case TOOL_REPLY_IN_THREAD:
        return replyInThread(args, ctx);
      case TOOL_EDIT_OWN_COMMENT:
        return editOwnComment(args, ctx);
      case TOOL_DELETE_OWN_COMMENT:
        return deleteOwnComment(args, ctx);
      case TOOL_UPSERT_STICKY_COMMENT:
        return upsertStickyComment(args, ctx);
      default:
        return Promise.resolve(refuse(`unknown tool: ${name}`));
    }
  },
};

async function comment(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const thread = parseThreadArg(args.thread, ctx);
  if (!thread.ok) return refuse(thread.error);
  const body = parseBody(args.body);
  if (!body.ok) return refuse(body.error);
  const denied = repoRefused(thread.value.repo, ctx);
  if (denied) return refuse(denied);

  const created = await ctx.api.createComment(thread.value, body.value);
  await recordCreated(created, thread.value, false, ctx);
  return ok(`commented on ${repoSlug(thread.value.repo)}#${thread.value.number} (comment ${created.id})\n${created.html_url}`);
}

async function replyInThread(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const thread = parseThreadArg(args.thread, ctx, 'pull');
  if (!thread.ok) return refuse(thread.error);
  const body = parseBody(args.body);
  if (!body.ok) return refuse(body.error);
  const threadId = typeof args.threadId === 'string' ? args.threadId : '';
  const parsed = parseThreadId(threadId);
  if (!parsed || parsed.kind !== 'review-thread') {
    return refuse(`threadId: expected a review conversation "rt:<id>", got ${JSON.stringify(args.threadId ?? null)}`);
  }
  const pull: ThreadRef = { ...thread.value, kind: 'pull' };
  const denied = repoRefused(pull.repo, ctx);
  if (denied) return refuse(denied);

  const created = await ctx.api.replyToReviewComment(pull, parsed.rootCommentId, body.value);
  await recordCreated(created, pull, true, ctx);
  return ok(`replied in ${threadId} on ${repoSlug(pull.repo)}#${pull.number} (comment ${created.id})\n${created.html_url}`);
}

async function editOwnComment(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const thread = parseThreadArg(args.thread, ctx);
  if (!thread.ok) return refuse(thread.error);
  const commentId = parseCommentId(args.commentId);
  if (!commentId.ok) return refuse(commentId.error);
  const body = parseBody(args.body);
  if (!body.ok) return refuse(body.error);
  const endpoint = parseEndpoint(args.review);
  if (!endpoint.ok) return refuse(endpoint.error);
  const denied = repoRefused(thread.value.repo, ctx);
  if (denied) return refuse(denied);

  const found = await findComment(thread.value, commentId.value, ctx, endpoint.value);
  if (!found.ok) return refuse(found.error);
  const target = found.value;
  if (target.comment.author.login !== ctx.botLogin) {
    return refuse(
      `refused: comment ${commentId.value} was written by ${target.comment.author.login}, not ${ctx.botLogin}; this tool only edits its own comments`,
    );
  }

  const previousBody = target.comment.body;
  const updated = await ctx.api.updateComment(thread.value.repo, commentId.value, body.value, target.review);
  await recordEdited(commentId.value, previousBody, thread.value, target.review, ctx);
  return ok(`edited comment ${updated.id} on ${repoSlug(thread.value.repo)}#${thread.value.number}\n${updated.html_url}`);
}

async function deleteOwnComment(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const thread = parseThreadArg(args.thread, ctx);
  if (!thread.ok) return refuse(thread.error);
  const commentId = parseCommentId(args.commentId);
  if (!commentId.ok) return refuse(commentId.error);
  const endpoint = parseEndpoint(args.review);
  if (!endpoint.ok) return refuse(endpoint.error);
  const denied = repoRefused(thread.value.repo, ctx);
  if (denied) return refuse(denied);

  const found = await findComment(thread.value, commentId.value, ctx, endpoint.value);
  if (!found.ok) return refuse(found.error);
  const target = found.value;
  if (target.comment.author.login !== ctx.botLogin) {
    return refuse(
      `refused: comment ${commentId.value} was written by ${target.comment.author.login}, not ${ctx.botLogin}; this tool only deletes its own comments`,
    );
  }

  await ctx.api.deleteComment(thread.value.repo, commentId.value, target.review);
  store(ctx).recordDeletedComment({
    repo: repoSlug(thread.value.repo),
    commentId: commentId.value,
    previousBody: target.comment.body,
    review: target.review,
    thread: locator(thread.value),
  });
  await ctx.state.flush();
  return ok(
    `deleted comment ${commentId.value} on ${repoSlug(thread.value.repo)}#${thread.value.number} (a delete cannot be rolled back)`,
  );
}

async function upsertStickyComment(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const thread = parseThreadArg(args.thread, ctx);
  if (!thread.ok) return refuse(thread.error);
  const marker = parseBody(args.marker, 'marker');
  if (!marker.ok) return refuse(marker.error);
  const body = parseBody(args.body);
  if (!body.ok) return refuse(body.error);
  const denied = repoRefused(thread.value.repo, ctx);
  if (denied) return refuse(denied);

  const html = stickyMarker(marker.value);
  const next = stickyBody(marker.value, body.value);
  const existing = (await ctx.api.listComments(thread.value)).find(
    (c) => c.author.login === ctx.botLogin && c.body.includes(html),
  );

  if (!existing) {
    const created = await ctx.api.createComment(thread.value, next);
    await recordCreated(created, thread.value, false, ctx);
    return ok(
      `created sticky ${html} on ${repoSlug(thread.value.repo)}#${thread.value.number} (comment ${created.id})\n${created.html_url}`,
    );
  }

  const previousBody = existing.body;
  const updated = await ctx.api.updateComment(thread.value.repo, existing.id, next, false);
  await recordEdited(existing.id, previousBody, thread.value, false, ctx);
  return ok(
    `updated sticky ${html} on ${repoSlug(thread.value.repo)}#${thread.value.number} (comment ${updated.id})\n${updated.html_url}`,
  );
}

/**
 * The entry point .5's `channels/publish` shares with these tools: a comment
 * this server just created, booked under the current checkpoint and flushed.
 */
export async function recordCreated(
  created: Pick<Comment, 'id'>,
  thread: ThreadRef,
  review: boolean,
  ctx: Pick<ToolContext, 'state'>,
): Promise<void> {
  store(ctx).recordCreatedComment({
    repo: repoSlug(thread.repo),
    commentId: created.id,
    review,
    thread: locator(thread),
  });
  await ctx.state.flush();
}

/**
 * The entry point .5 uses when it edits a comment outside these tools: the
 * previous body, booked under the current checkpoint and flushed.
 */
export async function recordEdited(
  commentId: number,
  previousBody: string,
  thread: ThreadRef,
  review: boolean,
  ctx: Pick<ToolContext, 'state'>,
): Promise<void> {
  store(ctx).recordEditedComment({
    repo: repoSlug(thread.repo),
    commentId,
    previousBody,
    review,
    thread: locator(thread),
  });
  await ctx.state.flush();
}

// ─────────────────────────────────────────────────────────────────────────────
// state/rollback (SPEC §8.5, §8.6)
// ─────────────────────────────────────────────────────────────────────────────

/** One action the rollback took, or could not take. */
export interface RollbackItem {
  /** `delete` undoes a create, `restore` undoes an edit, `none` is unundoable. */
  action: 'delete' | 'restore' | 'none';
  repo: string;
  commentId: number;
  review: boolean;
  thread?: ThreadLocator;
  /** Why it could not be undone. Absent on a success. */
  reason?: string;
}

/**
 * One thing a rollback actually did, reported to the caller as it happens
 * (review round 3, finding 1).
 *
 * Deliberately *not* part of {@link CommentRollbackResult}: `body` is comment
 * prose and the receipt goes to the host over the wire, while this is an
 * internal fact the server needs to keep its thread knowledge true. It is
 * reported per success rather than derived from the receipt afterwards so that
 * the order is the order the writes happened in — a delete that lowers the
 * bot's latest comment must be seen before a restore that refreshes it.
 */
export interface RollbackEffect {
  action: 'delete' | 'restore';
  thread: ThreadRef;
  commentId: number;
  review: boolean;
  /** The body now on GitHub. A restore has one; a delete does not. */
  body?: string;
}

/**
 * The §8.6 response, plus the receipt the contract asks for: what was undone
 * and what was not. Extra result fields are explicitly tolerated (§8), so a
 * host that only knows `checkpoint`/`success`/`reason` still reads this.
 */
export interface CommentRollbackResult extends StateRollbackResult {
  undone: RollbackItem[];
  notUndone: RollbackItem[];
}

/**
 * Undo the comment writes made after `params.checkpoint`, best effort: delete
 * what was created, restore the previous body of what was edited, and report
 * every action that failed and every delete that cannot be undone at all.
 *
 * Three properties the receipt rests on:
 *
 *   - **The allow-list binds the undo.** A record naming a repository outside
 *     GITHUB_REPOS is reported, by name, as not undone — never executed.
 *   - **A comment is its repository, its id *and* its kind.** An issue comment
 *     and a review comment can share an id (they are numbered by different
 *     endpoints), so the dedup key carries `review` and so does every call.
 *   - **One restore per comment, to the oldest body in the range.** Several
 *     edits of one comment collapse into a single update to the body it had at
 *     the checkpoint; the intermediate bodies are never written, and a failure
 *     retains only that one target, so no retry can resurrect a body the
 *     checkpoint never named.
 *   - **An action that did not happen stays booked.** Whatever could not be
 *     undone is recorded again under the checkpoint before the result is
 *     flushed, so a retry attempts it once more and cannot report a completed
 *     rollback over a state that was never restored. A delete is booked again
 *     too: GitHub cannot restore it, so no retry of this checkpoint will ever
 *     be a full success, and the receipt keeps saying so.
 *
 * Throws {@link McplRpcError} -32005 for a checkpoint that is unknown or was
 * abandoned by an earlier rollback (§8.7) — the only outcome the §8.6 result
 * shape cannot express.
 */
export async function rollbackComments(
  params: StateRollbackParams,
  ctx: ToolContext,
  onUndone?: (effect: RollbackEffect) => void,
): Promise<CommentRollbackResult> {
  if (params.featureSet !== COMMENTS_FEATURE_SET) {
    return {
      checkpoint: params.checkpoint,
      success: false,
      reason: `Feature set '${params.featureSet}' does not support rollback`,
      undone: [],
      notUndone: [],
    };
  }

  const state = store(ctx);
  const plan = state.rollback(params.checkpoint);
  if (!plan) {
    const status = state.checkpointStatus(params.checkpoint);
    throw new McplRpcError(ERR_CHECKPOINT_NOT_FOUND, 'Checkpoint not found', {
      checkpoint: params.checkpoint,
      reason:
        status === 'abandoned'
          ? 'an earlier rollback left this checkpoint behind; the state it named can no longer be restored'
          : 'no such checkpoint',
    });
  }

  const undone: RollbackItem[] = [];
  const notUndone: RollbackItem[] = [];
  /** Comments this rollback actually deleted, by {@link idKey}. */
  const deletedKeys = new Set<string>();
  /** Comments a create record was already handled for, duplicates included. */
  const handledKeys = new Set<string>();
  /** Records to book again, because their action did not happen. */
  const keptCreated: typeof plan.created = [];
  const keptEdited: typeof plan.edited = [];

  for (const created of plan.created) {
    const key = idKey(created.repo, created.commentId, created.review);
    if (handledKeys.has(key)) continue;
    handledKeys.add(key);
    const item: RollbackItem = {
      action: 'delete',
      repo: created.repo,
      commentId: created.commentId,
      review: created.review,
      thread: created.thread,
    };
    const repo = recordRepo(created.repo, ctx);
    if (!repo.ok) {
      notUndone.push({ ...item, reason: repo.error });
      keptCreated.push(created);
      continue;
    }
    try {
      await ctx.api.deleteComment(repo.value, created.commentId, created.review);
      deletedKeys.add(key);
      undone.push(item);
      if (created.thread) {
        onUndone?.({
          action: 'delete',
          thread: { repo: repo.value, number: created.thread.number, kind: created.thread.kind },
          commentId: created.commentId,
          review: created.review,
        });
      }
    } catch (err) {
      notUndone.push({ ...item, reason: message(err) });
      keptCreated.push(created);
    }
  }

  // One restore per comment: the body it had when the checkpoint was taken,
  // which is the *oldest* previous body in the range. The plan is newest first,
  // so the last record for an identity is the oldest one; the bodies in between
  // are states the rollback never has to pass through, and writing them would
  // be a detour whose failure could strand the comment on an intermediate
  // version. `Map` keeps the first insertion's position and the last value, so
  // this collapses the records without reordering the comments.
  const targetEdit = new Map<string, (typeof plan.edited)[number]>();
  for (const edited of plan.edited) {
    targetEdit.set(idKey(edited.repo, edited.commentId, edited.review), edited);
  }

  for (const [key, edited] of targetEdit) {
    // A comment this rollback deleted is gone: the delete subsumes the restore,
    // so it is neither an action nor a failure. A delete that *failed* leaves
    // the comment standing, and its edit is restored as usual.
    if (deletedKeys.has(key)) continue;
    const item: RollbackItem = {
      action: 'restore',
      repo: edited.repo,
      commentId: edited.commentId,
      review: edited.review,
      thread: edited.thread,
    };
    const repo = recordRepo(edited.repo, ctx);
    if (!repo.ok) {
      notUndone.push({ ...item, reason: repo.error });
      keptEdited.push(edited);
      continue;
    }
    try {
      await ctx.api.updateComment(repo.value, edited.commentId, edited.previousBody, edited.review);
      undone.push(item);
      if (edited.thread) {
        onUndone?.({
          action: 'restore',
          thread: { repo: repo.value, number: edited.thread.number, kind: edited.thread.kind },
          commentId: edited.commentId,
          review: edited.review,
          body: edited.previousBody,
        });
      }
    } catch (err) {
      notUndone.push({ ...item, reason: message(err) });
      keptEdited.push(edited);
    }
  }

  for (const deleted of plan.deleted ?? []) {
    notUndone.push({
      action: 'none',
      repo: deleted.repo,
      commentId: deleted.commentId,
      review: deleted.review,
      thread: deleted.thread,
      reason: 'the comment was deleted; GitHub cannot restore a deleted comment',
    });
  }

  // Book the unresolved records again, in the order they were made: the plan is
  // newest first and a bucket replays in insertion order. Only the collapsed
  // restore target is kept per comment, so a retry aims at the same body this
  // run did and a superseded intermediate body can never come back.
  for (const record of keptCreated.reverse()) state.recordCreatedComment(record);
  for (const record of keptEdited.reverse()) state.recordEditedComment(record);
  for (const record of [...(plan.deleted ?? [])].reverse()) state.recordDeletedComment(record);

  await ctx.state.flush();
  const result: CommentRollbackResult = {
    checkpoint: params.checkpoint,
    success: notUndone.length === 0,
    undone,
    notUndone,
  };
  if (notUndone.length > 0) {
    result.reason = bounded(
      `undid ${undone.length} of ${undone.length + notUndone.length} actions; could not undo ${notUndone
        .map((i) => `${i.repo} comment ${i.commentId} (${i.reason})`)
        .join('; ')}`,
      LIMITS.commentChars,
    );
    ctx.logger.warn(`rollback ${params.checkpoint}: ${result.reason}`);
  }
  return result;
}

/**
 * A comment's identity for dedup: the repository, the endpoint that owns the
 * id, and the id. `issues/12` and `pulls/12` are two different comments.
 */
function idKey(repo: string, commentId: number, review: boolean): string {
  return `${repo}#${review ? 'pulls' : 'issues'}/${commentId}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
