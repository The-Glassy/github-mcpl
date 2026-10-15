/**
 * Channels (TASK-SRHKG.1.5) — one MCPL channel per issue or pull request.
 *
 * The contract's channel bullets, and nothing beyond them:
 *
 *   - **Descriptors.** `github:<owner>/<name>#<number>`, type `github`,
 *     `bidirectional`, label `"<owner>/<name>#<number>: <title>"` with the
 *     title bounded to 80 chars, address `{ owner, name, number, kind }`.
 *     The id, label and address all come from types.ts so the format lives in
 *     exactly one place.
 *   - **Lazy registration.** A channel is announced on the first event on a
 *     thread ({@link ChannelRegistry.deliver}) or the first tool touch of one
 *     ({@link ChannelRegistry.ensureChannel}) — never a bulk enumeration of
 *     the repository, which would register every issue a repo ever had. Every
 *     touch of one channel is serialized against the others, so a registration
 *     still in flight cannot swallow what the touch behind it knows. Every
 *     announcement — `channels/register` and `channels/changed` — asks
 *     {@link ChannelRegistryOptions.canRegister} first, so the registry never
 *     exercises a capability the host has not granted.
 *   - **`channels/changed`** when a registered channel's label changes (the
 *     title was edited, or arrived after a title-less tool touch) or when the
 *     thread closes or reopens. What the registry reports is what the host
 *     *acknowledged*: a refused or undelivered update leaves the descriptor
 *     where it was and is retried on the channel's next touch.
 *   - **Incoming.** {@link ChannelRegistry.deliver} takes the outputs of .4
 *     (`tagsFor` → tags + metadata, `renderEvent` → content) and sends one
 *     `channels/incoming` message, with the contract's thread-id rules, after
 *     asking {@link ChannelRegistryOptions.canDeliver} — the registration it
 *     waits behind is a round trip, and the grant can narrow inside it.
 *   - **Publish.** {@link ChannelRegistry.handlePublish} maps a host publish
 *     onto `createComment` or `replyToReviewComment`.
 *   - **Typing.** A no-op that answers success: GitHub has no typing surface.
 *
 * `channels/open`, `channels/close` and `channels/acknowledge` are not
 * declared for this server, so nothing here implements them.
 *
 * The host connection is reached through {@link HostConnection}, a one-method
 * seam this module defines, so .9 can hand in an `McplConnection` and a test
 * can hand in a recorder. Stdout belongs to JSON-RPC; every diagnostic goes
 * through the {@link Logger}, which writes to stderr.
 */

import {
  ERR_UNKNOWN_CHANNEL,
  method,
  type ChannelDescriptor,
  type ChannelsChangedResult,
  type ChannelsIncomingParams,
  type ChannelsIncomingResult,
  type ChannelsPublishParams,
  type ChannelsPublishResult,
  type ChannelsRegisterParams,
  type ChannelsRegisterResult,
  type ChannelsTypingParams,
  type ContentBlock,
  type IncomingChannelMessage,
} from '@animalabs/mcpl-core';
import { McplRpcError } from './errors.js';
import {
  CHANNEL_TYPE,
  channelAddress,
  channelId,
  channelLabel,
  parseThreadId,
  repoSlug,
  stderrLogger,
  type Comment,
  type EventMetadata,
  type GitHubApi,
  type Logger,
  type NormalizedEvent,
  type ThreadRef,
} from './types.js';

/** JSON-RPC: the request's params are not usable (App. A). */
const ERR_INVALID_PARAMS = -32602;

// ─────────────────────────────────────────────────────────────────────────────
// Seams and shapes this module defines (not in types.ts; .9 reconciles)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The host, as this module needs it: one way to send a request and await its
 * result. `McplConnection.sendRequest` satisfies it directly.
 *
 * Deliberately requests only — a notification cannot report whether the host
 * accepted a descriptor or a message, and §14.5 makes that per-item answer
 * the point of `channels/register` and `channels/changed`.
 */
export interface HostConnection {
  send(method: string, params: unknown): Promise<unknown>;
}

export interface ChannelRegistryOptions {
  host: HostConnection;
  logger?: Logger;
  /**
   * May the registry announce a descriptor *right now*?
   *
   * Consulted immediately before each of the two outbound calls that announce
   * one — `channels/register` and `channels/changed` — rather than once when
   * the registry is built: the grant is the host's and it can narrow at any
   * time (§5.4), so a registration decided before a `featureSets/update` must
   * not go out after it. A denied answer leaves the channel unregistered and
   * retryable, exactly as a host refusal does.
   *
   * Absent means "yes", which is what a test driving the registry on its own
   * wants; .9 passes `channels.register` from the live grant.
   */
  canRegister?: () => boolean;
  /**
   * May the registry deliver a `channels/incoming` message *right now*?
   *
   * Asked for the same reason as {@link ChannelRegistryOptions.canRegister},
   * and at the same moment relative to the send — but it is a *separate*
   * question, and the delivery used to be decided only by the caller before
   * the registration it waits behind (WP9 review round 2, finding 1).
   * {@link ChannelRegistry.deliver} awaits a queued registration or refresh
   * before it can send, and a `featureSets/update` the host acknowledged in
   * that window has to stop the message: the answer is taken after the touch,
   * immediately before `channels/incoming` goes out.
   *
   * Absent means "yes"; .9 passes the live `channels.incoming` grant and the
   * selection of `github.events`.
   */
  canDeliver?: () => boolean;
}

/**
 * `channels/publish` as this server needs it. SPEC 0.5's
 * {@link ChannelsPublishParams} carries no `threadId`, but the contract routes
 * a publish by exactly that (`rt:<id>` → review reply, `review:<id>` and
 * absent → comment), and §14.4 already hands the host a `threadId` on
 * `context/beforeInference`. So the field is optional here and .9 reconciles
 * it with whatever the host actually sends (see the report's contract gaps).
 */
export interface GitHubPublishParams extends ChannelsPublishParams {
  threadId?: string;
}

/** Which GitHubApi call a publish took. */
export type PublishRoute = 'comment' | 'review-reply' | 'none';

/**
 * What {@link ChannelRegistry.handlePublish} returns — a
 * {@link ChannelsPublishResult} the server can answer the host with, widened
 * with what .7's state has to record to be able to roll the write back:
 *
 *   - `delivered` — whether a comment was created.
 *   - `messageId` — `String(commentId)`, the SPEC's string message id.
 *   - `commentId` — the created comment's numeric GitHub id, the handle
 *     `updateComment`/`deleteComment` (and so rollback) take.
 *   - `htmlUrl` — the created comment's `html_url`.
 *   - `route` — which GitHubApi call was used; `'none'` when nothing was sent.
 *   - `isReviewComment` — true for a review-thread reply, which GitHub edits
 *     and deletes through `pulls/comments/{id}` rather than
 *     `issues/comments/{id}` (the `review` flag of those seam methods).
 *   - `thread` — the issue or PR written to.
 *   - `reason` — why nothing was delivered, when `delivered` is false.
 *
 * A refusal is not reported here: an unknown channel and an attachment both
 * throw {@link McplRpcError} so the server answers a JSON-RPC error object,
 * which §6.6 requires over a result carrying a failure flag.
 */
export interface PublishOutcome extends ChannelsPublishResult {
  delivered: boolean;
  messageId?: string;
  commentId?: number;
  htmlUrl?: string;
  route: PublishRoute;
  isReviewComment?: boolean;
  thread?: ThreadRef;
  reason?: string;
}

/** What {@link ChannelRegistry.deliver} reports back to the pipeline (.9). */
export interface DeliveryOutcome {
  /** False when the event has no thread, or the host refused the message. */
  delivered: boolean;
  channelId?: string;
  messageId?: string;
  threadId?: string;
  /** Why nothing was delivered. */
  reason?: string;
}

/**
 * The metadata of an incoming message: everything `tagsFor` produced, plus the
 * contract's `sender`. mcpl-core's `IncomingChannelMessage.author` is
 * `{ id, name }` and cannot carry `isBot`, so the contract's
 * `sender { login, isBot }` rides in the (open) `metadata` object, where the
 * host's `metadataTrue` matchers can reach it.
 */
export interface IncomingMetadata extends EventMetadata {
  sender: { login: string; isBot: boolean };
}

// ─────────────────────────────────────────────────────────────────────────────
// Thread ids and descriptors
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The channel-level `threadId` of an event, per the contract: a review comment
 * belongs to `rt:<root review comment id>` (the root is the comment the reply
 * chain hangs off, so a reply reports its `inReplyTo`), a review summary to
 * `review:<review id>`, and a top-level comment to no thread at all.
 */
export function threadIdForEvent(event: NormalizedEvent): string | undefined {
  if (event.reviewComment) {
    const root = event.reviewComment.inReplyTo ?? event.reviewComment.id;
    return `rt:${root}`;
  }
  if (event.review) return `review:${event.review.id}`;
  return undefined;
}

/**
 * The descriptor of one thread. `title` absent means no title is known yet (a
 * tool touched the thread before any event named it); the label is then the
 * bare `<owner>/<name>#<number>` and the first title that arrives updates it
 * through `channels/changed`.
 */
export function toDescriptor(thread: ThreadRef, title?: string, state: ThreadState = 'open'): ChannelDescriptor {
  return {
    id: channelId(thread),
    type: CHANNEL_TYPE,
    label: title === undefined ? `${repoSlug(thread.repo)}#${thread.number}` : channelLabel(thread, title),
    direction: 'bidirectional',
    address: channelAddress(thread),
    metadata: { kind: thread.kind, state },
  };
}

/** Open or closed, the only descriptor state a label change tracks. */
export type ThreadState = 'open' | 'closed';

/** The event kinds that move a thread between open and closed. */
function stateAfter(event: NormalizedEvent, current: ThreadState): ThreadState {
  switch (event.kind) {
    case 'issue.closed':
    case 'pull.closed':
      return 'closed';
    case 'issue.reopened':
    case 'issue.opened':
    case 'pull.opened':
      return 'open';
    default:
      return current;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One registered channel. The descriptor the host **acknowledged** is kept
 * apart from the title and state this server knows: a `channels/changed` the
 * host refuses, or that never reaches it, must leave the two sides agreeing
 * about what the host believes, and must stay retryable on the next touch.
 */
interface ChannelRecord {
  thread: ThreadRef;
  /** The last descriptor the host accepted — what `list()` and `get()` report. */
  acknowledged: ChannelDescriptor;
  /** The title this server knows; absent until one arrives. May be ahead of `acknowledged`. */
  title?: string;
  /** The state this server knows. May be ahead of `acknowledged`. */
  state: ThreadState;
}

/**
 * Does the host already know this descriptor? `label`, `metadata` and
 * `address` are what can move for a given channel id: the first two with the
 * thread's title and state, and the address with its `kind`, which a tool
 * touch may have registered as a guess and an event later corrects (WP9
 * review round 3, finding 1). `type` and `direction` are constants of this
 * server.
 */
function sameDescriptor(a: ChannelDescriptor, b: ChannelDescriptor): boolean {
  return (
    a.id === b.id &&
    a.label === b.label &&
    JSON.stringify(a.address) === JSON.stringify(b.address) &&
    JSON.stringify(a.metadata) === JSON.stringify(b.metadata)
  );
}

/**
 * The registered channels of one connection. A new connection gets a new
 * registry: registration is per-grant and per-host (§14.5), so nothing here
 * outlives the connection that announced it.
 */
export class ChannelRegistry {
  private readonly host: HostConnection;
  private readonly logger: Logger;
  private readonly canRegister: () => boolean;
  private readonly canDeliver: () => boolean;
  private readonly records = new Map<string, ChannelRecord>();
  /**
   * The tail of the work queued for a channel. Every touch of one channel runs
   * after the previous one has settled, so a registration still in flight
   * cannot swallow the title and state of the event behind it, and two touches
   * cannot each decide to send `channels/changed`.
   */
  private readonly queue = new Map<string, Promise<void>>();

  constructor(opts: ChannelRegistryOptions) {
    this.host = opts.host;
    this.logger = opts.logger ?? stderrLogger('channels');
    this.canRegister = opts.canRegister ?? (() => true);
    this.canDeliver = opts.canDeliver ?? (() => true);
  }

  /** Every registered descriptor — the body of a `channels/list` answer. */
  list(): ChannelDescriptor[] {
    return [...this.records.values()].map((r) => r.acknowledged);
  }

  /** The descriptor of a channel id, or undefined when it is not registered. */
  get(id: string): ChannelDescriptor | undefined {
    return this.records.get(id)?.acknowledged;
  }

  /**
   * The issue or PR a registered channel id names. The id itself carries no
   * `issue | pull` discriminator (see docs/contract-notes.md), so the registry
   * — which registered it — is the only place the full `ThreadRef` exists.
   */
  threadFor(id: string): ThreadRef | undefined {
    return this.records.get(id)?.thread;
  }

  /**
   * Register the channel of `thread` if it is not registered yet, and update
   * its label if `title` or the thread's state moved. This is the "first tool
   * touch" entry point: a tool that acts on a thread calls it with whatever
   * title it already fetched (or none).
   *
   * Returns the descriptor the host has acknowledged, or undefined when the
   * host refused the registration.
   */
  async ensureChannel(thread: ThreadRef, title?: string, state?: ThreadState): Promise<ChannelDescriptor | undefined> {
    return this.touch(thread, (current) => ({ title, state: state ?? current?.state ?? 'open' }));
  }

  /**
   * Register or reconcile one channel, serialized against every other touch of
   * it. `fields` is evaluated inside the queue, against the record as it stands
   * *then*, so a caller can derive the title and state it wants from the
   * channel's current ones without reading a value that a queued touch is
   * about to change.
   *
   * A registered channel also takes the `kind` of the thread it is touched
   * with. The channel id carries no `issue | pull` discriminator, so this
   * record is the only place the full `ThreadRef` lives — and `kind` is the
   * one part of it that can be wrong, because the first touch of a thread may
   * have been a tool call naming `#58`, which defaults to `issue` whether or
   * not 58 is a pull request. The caller is responsible for handing over a
   * *resolved* kind (the server resolves every one through
   * `ThreadKnowledge`'s rule 2, and an event's is authoritative by
   * construction), so the newest one wins: it becomes the thread this channel
   * publishes to, and `refresh` tells the host through `channels/changed`,
   * because the descriptor's address moved with it. Without this a review
   * reply on such a channel was refused for the rest of the connection (WP9
   * review round 3, finding 1).
   */
  private touch(
    thread: ThreadRef,
    fields: (current: ChannelRecord | undefined) => { title?: string; state: ThreadState },
  ): Promise<ChannelDescriptor | undefined> {
    const id = channelId(thread);
    return this.enqueue(id, async () => {
      const known = this.records.get(id);
      const { title, state } = fields(known);
      if (!known) return this.register(thread, title, state);
      if (known.thread.kind !== thread.kind) {
        this.logger.debug('channel kind reconciled', { channel: id, from: known.thread.kind, to: thread.kind });
        known.thread = thread;
      }
      await this.refresh(known, title, state);
      return known.acknowledged;
    });
  }

  /** Run `work` after everything already queued for `id` has settled. */
  private enqueue<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queue.get(id) ?? Promise.resolve();
    // `work` runs however the previous touch ended: one failed registration
    // must not wedge the channel's queue.
    const run = previous.then(work, work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    const settled = tail.then(() => {
      // Nothing queued behind this one: drop the entry rather than keep one
      // promise per channel ever touched.
      if (this.queue.get(id) === settled) this.queue.delete(id);
    });
    this.queue.set(id, settled);
    return run;
  }

  /** Announce one new channel with `channels/register` (§14.5, itemized). */
  private async register(
    thread: ThreadRef,
    title: string | undefined,
    state: ThreadState,
  ): Promise<ChannelDescriptor | undefined> {
    const descriptor = toDescriptor(thread, title, state);
    if (!this.canRegister()) {
      // Not recorded, and nothing sent: announcing a channel is
      // `channels.register`, and a path the host did not grant is denied by
      // its absence (§5.4). The next touch tries again, so a widened grant
      // picks the channel up.
      this.logger.info('channel not announced', { channel: descriptor.id, reason: 'registration is not granted' });
      return undefined;
    }
    const params: ChannelsRegisterParams = { channels: [descriptor] };
    let result: ChannelsRegisterResult | undefined;
    try {
      result = (await this.host.send(method.CHANNELS_REGISTER, params)) as ChannelsRegisterResult | undefined;
    } catch (err) {
      this.logger.warn('channels/register failed', { channel: descriptor.id, error: (err as Error).message });
      return undefined;
    }

    const entry = result?.results?.find((r) => r.id === descriptor.id);
    if (entry && entry.accepted === false) {
      // Not recorded: a channel marked known here would never be announced
      // again after the host's policy widened.
      this.logger.info('host refused channel', { channel: descriptor.id, reason: entry.reason });
      return undefined;
    }

    this.records.set(descriptor.id, { thread, acknowledged: descriptor, title, state });
    this.logger.debug('channel registered', { channel: descriptor.id, label: descriptor.label });
    return descriptor;
  }

  /**
   * Take in a title and a state, and tell the host with `channels/changed`
   * when the descriptor they produce is not the one it acknowledged.
   *
   * The record's acknowledged descriptor advances only on an accepted update:
   * a host that answers `accepted: false`, and a request that never gets an
   * answer, both leave it where it was, so `get()` keeps reporting what the
   * host actually believes and the next touch of the channel retries.
   */
  private async refresh(record: ChannelRecord, title?: string, state?: ThreadState): Promise<void> {
    if (title !== undefined) record.title = title;
    if (state !== undefined) record.state = state;

    const desired = toDescriptor(record.thread, record.title, record.state);
    if (sameDescriptor(desired, record.acknowledged)) return;

    if (!this.canRegister()) {
      // `channels/changed` re-announces a descriptor, so it needs the same
      // authority as the registration it amends. The record keeps what the
      // host acknowledged and the next touch retries.
      this.logger.info('channel update not announced', { channel: desired.id, reason: 'registration is not granted' });
      return;
    }

    let result: ChannelsChangedResult | undefined;
    try {
      result = (await this.host.send(method.CHANNELS_CHANGED, { updated: [desired] })) as
        | ChannelsChangedResult
        | undefined;
    } catch (err) {
      // The host keeps the descriptor it has; the channel itself still works,
      // and the next touch sends the update again.
      this.logger.warn('channels/changed failed', { channel: desired.id, error: (err as Error).message });
      return;
    }

    const entry = result?.results?.find((r) => r.id === desired.id);
    if (entry && entry.accepted === false) {
      this.logger.info('host refused channel update', { channel: desired.id, reason: entry.reason });
      return;
    }

    record.acknowledged = desired;
    this.logger.debug('channel changed', { channel: desired.id, label: desired.label, state: record.state });
  }

  // ── Incoming ──

  /**
   * Deliver one event to its channel: register the channel if this is the
   * first the host hears of the thread, update the label if the title or state
   * moved, then send one `channels/incoming` message.
   *
   * `tags`, `metadata` and `content` are what .4 produced for this event
   * (`tagsFor` and `renderEvent`); this module never re-derives them, and
   * `event.raw` never leaves the pipeline.
   */
  async deliver(
    event: NormalizedEvent,
    tags: string[],
    metadata: EventMetadata,
    content: ContentBlock[],
  ): Promise<DeliveryOutcome> {
    if (!event.thread) {
      // A push or a repository-level event belongs to no channel; .9 sends
      // those as push/event only.
      return { delivered: false, reason: 'no-thread' };
    }

    const thread = event.thread;
    const id = channelId(thread);
    // Both derived against the record as it stands when the touch runs, not as
    // it stands now: a registration or an update may still be in flight.
    const descriptor = await this.touch(thread, (current) => ({
      title: event.title,
      state: stateAfter(event, current?.state ?? 'open'),
    }));
    if (!descriptor) return { delivered: false, channelId: id, reason: 'channel-not-registered' };

    // After the touch, not before it: the registration this delivery waited
    // behind is an awaited round trip to the host, and a `featureSets/update`
    // acknowledged in that window must stop the message (WP9 review round 2,
    // finding 1). The event is dropped rather than queued — a stale event
    // delivered after the host narrowed its policy is exactly what the
    // reduction asked not to happen.
    if (!this.canDeliver()) {
      this.logger.info('channel delivery not sent', {
        channel: descriptor.id,
        event: event.id,
        reason: 'incoming is not granted',
      });
      return { delivered: false, channelId: descriptor.id, messageId: event.id, reason: 'incoming-not-granted' };
    }

    const threadId = threadIdForEvent(event);
    const incomingMetadata: IncomingMetadata = {
      ...metadata,
      sender: { login: event.actor.login, isBot: event.actor.isBot },
    };
    const message: IncomingChannelMessage = {
      channelId: descriptor.id,
      messageId: event.id,
      ...(threadId ? { threadId } : {}),
      author: { id: event.actor.login, name: event.actor.login },
      timestamp: event.receivedAt,
      content,
      metadata: incomingMetadata,
      tags,
    };

    const params: ChannelsIncomingParams = { messages: [message] };
    let result: ChannelsIncomingResult | undefined;
    try {
      result = (await this.host.send(method.CHANNELS_INCOMING, params)) as ChannelsIncomingResult | undefined;
    } catch (err) {
      this.logger.warn('channels/incoming failed', { channel: descriptor.id, error: (err as Error).message });
      return { delivered: false, channelId: descriptor.id, messageId: event.id, threadId, reason: 'host-error' };
    }

    const entry = result?.results?.find((r) => r.messageId === event.id);
    const delivered = entry?.accepted !== false;
    return {
      delivered,
      channelId: descriptor.id,
      messageId: event.id,
      threadId,
      ...(delivered ? {} : { reason: 'host-refused' }),
    };
  }

  // ── Publish ──

  /**
   * A host publish onto GitHub, routed by `threadId` exactly as the contract
   * says:
   *
   *   - absent      → `createComment` on the issue or PR;
   *   - `rt:<id>`   → `replyToReviewComment` in that review conversation;
   *   - `review:<id>` → `createComment` (a review summary has no reply API).
   *
   * Refusals, both as JSON-RPC error objects (§6.6):
   *   - an unknown or unregistered channel id → `-32023 Unknown channel`;
   *   - any non-text content block → `-32602 Invalid params`, naming the
   *     block type. Attachments are not supported in v1.
   *   - a `threadId` that is neither `rt:<id>` nor `review:<id>`, or an
   *     `rt:<id>` reply on an issue (review comments live on pull requests
   *     only) → `-32602 Invalid params`.
   *
   * See {@link PublishOutcome} for the return shape.
   */
  async handlePublish(params: GitHubPublishParams, api: GitHubApi): Promise<PublishOutcome> {
    const record = this.records.get(params.channelId);
    if (!record) {
      throw new McplRpcError(ERR_UNKNOWN_CHANNEL, `Unknown channel: ${params.channelId}`, {
        channelId: params.channelId,
      });
    }
    const thread = record.thread;

    const attachment = (params.content ?? []).find((block) => block.type !== 'text');
    if (attachment) {
      throw new McplRpcError(
        ERR_INVALID_PARAMS,
        `Attachments are not supported: github-mcpl publishes text only, got a '${attachment.type}' block`,
        { channelId: params.channelId, blockType: attachment.type },
      );
    }

    const text = (params.content ?? [])
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (!text) {
      // Nothing to post. Not an error: an empty turn is a host decision, and
      // an empty GitHub comment would be worse than none.
      this.logger.debug('publish skipped', { channel: params.channelId, reason: 'empty-content' });
      return { delivered: false, route: 'none', thread, reason: 'empty-content' };
    }

    const parsed = parseThreadId(params.threadId);
    if (params.threadId !== undefined && parsed === null) {
      throw new McplRpcError(
        ERR_INVALID_PARAMS,
        `Unknown threadId '${params.threadId}': expected 'rt:<review comment id>' or 'review:<review id>'`,
        { channelId: params.channelId, threadId: params.threadId },
      );
    }

    if (parsed?.kind === 'review-thread') {
      if (thread.kind !== 'pull') {
        throw new McplRpcError(
          ERR_INVALID_PARAMS,
          `threadId '${params.threadId}' names a review conversation, and ${params.channelId} is an issue`,
          { channelId: params.channelId, threadId: params.threadId },
        );
      }
      const comment = await api.replyToReviewComment(thread, parsed.rootCommentId, text);
      return this.published(comment, 'review-reply', thread, true);
    }

    // No threadId, or a review summary: both are a top-level comment.
    const comment = await api.createComment(thread, text);
    return this.published(comment, 'comment', thread, false);
  }

  private published(comment: Comment, route: PublishRoute, thread: ThreadRef, isReviewComment: boolean): PublishOutcome {
    this.logger.debug('published', { route, commentId: comment.id, thread: `${repoSlug(thread.repo)}#${thread.number}` });
    return {
      delivered: true,
      messageId: String(comment.id),
      commentId: comment.id,
      htmlUrl: comment.html_url,
      route,
      isReviewComment,
      thread,
    };
  }

  // ── Typing ──

  /**
   * `channels/typing` — a no-op that answers success. GitHub has no typing
   * indicator on an issue or a PR, and the alternative (a placeholder comment)
   * would be a visible write nobody asked for. SPEC §14 fixes no result shape
   * for the method, so the answer is an empty success object.
   */
  handleTyping(params: ChannelsTypingParams): Record<string, never> {
    this.logger.debug('typing ignored', { channel: params.channelId });
    return {};
  }
}
