/**
 * github.issues and github.pr — the issue and pull-request write tools
 * (TASK-SRHKG.1.6).
 *
 *   github.issues: create_issue, edit_issue, close_issue, reopen_issue
 *   github.pr:     create_pull_request, edit_pull_request, request_review
 *
 * Two feature sets, two ToolModules, one file: the contract's module map puts
 * them together and a host may enable either alone.
 *
 * Two refusals are the point of this file:
 *
 *   - a repository outside GITHUB_REPOS is refused by name (`resolveRepo`);
 *   - the base of a created or retargeted pull request must be in
 *     GITHUB_PR_BASE_ALLOW, and is refused by name otherwise. An empty
 *     allow-list means no pull request may be opened at all — deny by default.
 *
 * There is deliberately no merge tool and no branch deletion: a clone proposes,
 * a human merges.
 */

import {
  ISSUES_FEATURE_SET,
  PR_FEATURE_SET,
  TOOL_CLOSE_ISSUE,
  TOOL_CREATE_ISSUE,
  TOOL_CREATE_PULL_REQUEST,
  TOOL_EDIT_ISSUE,
  TOOL_EDIT_PULL_REQUEST,
  TOOL_REOPEN_ISSUE,
  TOOL_REQUEST_REVIEW,
  allowedBases,
  repoSlug,
  type IssueStateReason,
  type RepoRef,
  type ToolContext,
  type ToolDefinition,
  type ToolModule,
  type ToolResult,
  type UpdateIssueInput,
  type UpdatePullRequestInput,
} from './types.js';
import {
  FIELD,
  NUMBER_PROPERTY,
  REPO_PROPERTY,
  ToolArgumentError,
  boundedInline,
  echo,
  field,
  optionalBoolean,
  optionalString,
  oneOf,
  refuse,
  requireString,
  requireStringArray,
  resolveRepo,
  resolveThread,
  runTool,
  toolResult,
} from './tool-support.js';
import {
  renderIssue,
  renderPullRequest,
} from './tools-read.js';

/** The reasons `close_issue` accepts (the contract names exactly these two). */
const CLOSE_REASONS: readonly IssueStateReason[] = ['completed', 'not_planned'];

/**
 * GITHUB_PR_BASE_ALLOW, enforced for one repository (`allowedBases`). The
 * refusal names the branch asked for and the branches allowed there, so the
 * caller can correct it in one step.
 */
export function requireAllowedBase(base: string, repo: RepoRef, ctx: ToolContext): string {
  const bases = allowedBases(repo, ctx.prBaseAllow);
  if (bases.includes(base)) return base;
  const allowed =
    bases.length === 0
      ? `GITHUB_PR_BASE_ALLOW allows no branch on ${repoSlug(repo)}, so none may be targeted`
      : `allowed on ${repoSlug(repo)}: ${boundedInline(bases)}`;
  refuse(`base branch ${echo(base)} is not in GITHUB_PR_BASE_ALLOW (${allowed})`);
}

// ─────────────────────────────────────────────────────────────────────────────
// github.issues
// ─────────────────────────────────────────────────────────────────────────────

export const issuesTools: ToolDefinition[] = [
  {
    name: TOOL_CREATE_ISSUE,
    description: 'Open a new issue on the allowed repository.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PROPERTY,
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body (GitHub markdown)' },
      },
      required: ['title'],
    },
  },
  {
    name: TOOL_EDIT_ISSUE,
    description: 'Edit an issue’s title or body. At least one of the two is required.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PROPERTY,
        number: { type: 'integer', minimum: 1, description: 'Issue number' },
        title: { type: 'string', description: 'New title' },
        body: { type: 'string', description: 'New body, replacing the old one' },
      },
      required: ['number'],
    },
  },
  {
    name: TOOL_CLOSE_ISSUE,
    description:
      'Close an issue with a reason. With `comment`, the comment is posted first, so the ' +
      'closing note is visible above the close event.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PROPERTY,
        number: { type: 'integer', minimum: 1, description: 'Issue number' },
        reason: {
          type: 'string',
          enum: [...CLOSE_REASONS],
          description: 'completed (it was done) or not_planned (it will not be done)',
        },
        comment: { type: 'string', description: 'Optional comment posted before closing' },
      },
      required: ['number', 'reason'],
    },
  },
  {
    name: TOOL_REOPEN_ISSUE,
    description: 'Reopen a closed issue.',
    inputSchema: {
      type: 'object',
      properties: { repo: REPO_PROPERTY, number: { type: 'integer', minimum: 1, description: 'Issue number' } },
      required: ['number'],
    },
  },
];

async function callIssues(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  switch (name) {
    case TOOL_CREATE_ISSUE: {
      const repo = resolveRepo(args, ctx);
      const issue = await ctx.api.createIssue(repo, {
        title: requireString(args, 'title'),
        body: optionalString(args, 'body'),
      });
      return toolResult(renderIssue(issue));
    }
    case TOOL_EDIT_ISSUE: {
      const thread = resolveThread(args, ctx, 'issue');
      const input: UpdateIssueInput = {
        title: optionalString(args, 'title'),
        body: optionalString(args, 'body'),
      };
      if (input.title === undefined && input.body === undefined) {
        throw new ToolArgumentError('one of "title" or "body" is required; an edit that changes nothing is refused');
      }
      return toolResult(renderIssue(await ctx.api.updateIssue(thread, input)));
    }
    case TOOL_CLOSE_ISSUE: {
      const thread = resolveThread(args, ctx, 'issue');
      const reason = oneOf<IssueStateReason>(args, 'reason', CLOSE_REASONS);
      const comment = optionalString(args, 'comment');
      // The comment goes first: a close event with the explanation above it
      // reads in order, and if the close then fails the explanation stands.
      // It is not recorded in the checkpoint store — github.issues is not
      // rollback-capable (ROLLBACK_CAPABLE), and .7's rollback must not delete
      // a comment this tool wrote.
      if (comment !== undefined) await ctx.api.createComment(thread, comment);
      const issue = await ctx.api.updateIssue(thread, { state: 'closed', stateReason: reason });
      return toolResult(renderIssue(issue));
    }
    case TOOL_REOPEN_ISSUE: {
      const thread = resolveThread(args, ctx, 'issue');
      const issue = await ctx.api.updateIssue(thread, { state: 'open', stateReason: 'reopened' });
      return toolResult(renderIssue(issue));
    }
    default:
      throw new ToolArgumentError(`unknown tool for ${ISSUES_FEATURE_SET}: ${field(name)}`);
  }
}

/** The github.issues ToolModule the server (.9) registers. */
export const issuesToolModule: ToolModule = {
  featureSet: ISSUES_FEATURE_SET,
  tools: issuesTools,
  call: (name, args, ctx) => runTool(name, ctx, () => callIssues(name, args, ctx)),
};

// ─────────────────────────────────────────────────────────────────────────────
// github.pr
// ─────────────────────────────────────────────────────────────────────────────

export const prTools: ToolDefinition[] = [
  {
    name: TOOL_CREATE_PULL_REQUEST,
    description:
      'Open a pull request. The base branch must be one of the branches GITHUB_PR_BASE_ALLOW ' +
      'names; any other base is refused. There is no merge tool: a human merges.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PROPERTY,
        head: { type: 'string', description: 'Branch holding the changes' },
        base: { type: 'string', description: 'Branch to merge into; must be in GITHUB_PR_BASE_ALLOW' },
        title: { type: 'string', description: 'Pull-request title' },
        body: { type: 'string', description: 'Pull-request body (GitHub markdown)' },
        draft: { type: 'boolean', description: 'Open as a draft (default false)' },
      },
      required: ['head', 'base', 'title'],
    },
  },
  {
    name: TOOL_EDIT_PULL_REQUEST,
    description:
      'Edit a pull request’s title, body, base branch or draft state. At least one is required. ' +
      'A new base is checked against GITHUB_PR_BASE_ALLOW exactly as on creation.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PROPERTY,
        number: { type: 'integer', minimum: 1, description: 'Pull-request number' },
        title: { type: 'string', description: 'New title' },
        body: { type: 'string', description: 'New body, replacing the old one' },
        base: { type: 'string', description: 'Retarget to this branch; must be in GITHUB_PR_BASE_ALLOW' },
        draft: { type: 'boolean', description: 'Mark as draft (true) or ready for review (false)' },
      },
      required: ['number'],
    },
  },
  {
    name: TOOL_REQUEST_REVIEW,
    description: 'Request a review on a pull request from one or more GitHub logins.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: REPO_PROPERTY,
        number: NUMBER_PROPERTY,
        logins: {
          type: 'array',
          items: { type: 'string' },
          description: 'GitHub logins to request a review from',
        },
      },
      required: ['number', 'logins'],
    },
  },
];

async function callPr(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  switch (name) {
    case TOOL_CREATE_PULL_REQUEST: {
      const repo = resolveRepo(args, ctx);
      const base = requireAllowedBase(requireString(args, 'base'), repo, ctx);
      const pull = await ctx.api.createPullRequest(repo, {
        head: requireString(args, 'head'),
        base,
        title: requireString(args, 'title'),
        body: optionalString(args, 'body'),
        draft: optionalBoolean(args, 'draft'),
      });
      return toolResult(renderPullRequest(pull));
    }
    case TOOL_EDIT_PULL_REQUEST: {
      const thread = resolveThread(args, ctx, 'pull');
      const base = optionalString(args, 'base');
      const input: UpdatePullRequestInput = {
        title: optionalString(args, 'title'),
        body: optionalString(args, 'body'),
        base: base === undefined ? undefined : requireAllowedBase(base, thread.repo, ctx),
        draft: optionalBoolean(args, 'draft'),
      };
      if (
        input.title === undefined &&
        input.body === undefined &&
        input.base === undefined &&
        input.draft === undefined
      ) {
        throw new ToolArgumentError(
          'one of "title", "body", "base" or "draft" is required; an edit that changes nothing is refused',
        );
      }
      return toolResult(renderPullRequest(await ctx.api.updatePullRequest(thread, input)));
    }
    case TOOL_REQUEST_REVIEW: {
      const thread = resolveThread(args, ctx, 'pull');
      const logins = requireStringArray(args, 'logins');
      await ctx.api.requestReviewers(thread, logins);
      // requestReviewers returns nothing; the confirmation is the result rather
      // than a second round-trip to re-read the pull request.
      return toolResult(
        `requested a review from ${boundedInline(logins)} on ${field(
          repoSlug(thread.repo),
          FIELD.slug,
        )}#${thread.number}`,
      );
    }
    default:
      throw new ToolArgumentError(`unknown tool for ${PR_FEATURE_SET}: ${field(name)}`);
  }
}

/** The github.pr ToolModule the server (.9) registers. */
export const prToolModule: ToolModule = {
  featureSet: PR_FEATURE_SET,
  tools: prTools,
  call: (name, args, ctx) => runTool(name, ctx, () => callPr(name, args, ctx)),
};
