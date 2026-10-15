/**
 * Durable state and rollback bookkeeping (TASK-SRHKG.1.7).
 *
 * The contract's state bullet, and SPEC 0.5 §8:
 *
 *   - a JSON file at GITHUB_STATE_FILE, written atomically (temp file plus
 *     rename), carrying a `version` so a future shape change is detectable;
 *   - checkpoint lineage `{ id, parent, createdAt }`, a tree: rolling back and
 *     writing again branches (§8.2), exactly as slack-mcpl's `StateTracker`
 *     does, with the lineage made durable and the bookkeeping widened from
 *     "messages sent" to "comments created, edited and deleted";
 *   - per checkpoint: the comments this server created, the previous bodies of
 *     the comments it edited, and the comments it deleted;
 *   - `rollback(checkpointId)` computes what has to be undone (delete the
 *     created, restore the edited) and returns null for an unknown checkpoint
 *     so the caller can answer -32005 (§8.7);
 *   - the polling cursor `lastPollAt` and the dedup ring of the last
 *     {@link POLL_DEDUP_RING} poll keys (contract amendment 1), and the last
 *     polled head sha of each open pull request, bounded by
 *     {@link POLL_HEAD_MEMORY} (amendment 2a).
 *
 * **Which checkpoint a write lands under.** A tool records its write under
 * `current()`, and the routing layer creates a checkpoint *after* the call and
 * reports it in `state` (§8.2: the checkpoint names the state *including* that
 * write, which is slack-mcpl's order too). So the bucket keyed by checkpoint C
 * holds the writes that happened while C was current — the writes that came
 * *after* C was created. Rolling back to C therefore undoes C's own bucket and
 * the buckets of every checkpoint descending from C, and leaves everything
 * recorded before C existed ({@link ROOT_BUCKET}) alone.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { open, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  POLL_DEDUP_RING,
  POLL_HEAD_MEMORY,
  silentLogger,
  type CheckpointRecord,
  type CheckpointStatus,
  type CreatedComment,
  type EditedComment,
  type Logger,
  type RollbackPlan,
  type StateSnapshot,
  type StateStore,
  type ThreadKind,
} from './types.js';

/** The `version` field of the on-disk JSON. Bumped when the shape changes. */
export const STATE_VERSION = 1;

/**
 * The bucket writes land in before any checkpoint exists. No rollback touches
 * it: a write that preceded every checkpoint is part of the state the oldest
 * checkpoint names, so there is nothing to undo it back to.
 */
export const ROOT_BUCKET = 'root';

/** The thread a recorded comment hangs on, so a receipt can name it. */
export interface ThreadLocator {
  number: number;
  kind: ThreadKind;
}

/**
 * {@link CreatedComment} plus the thread it was created on (the contract's
 * "created comment ids (with thread)"). The delete path needs only
 * `repo`/`commentId`/`review`; the thread is what the rollback receipt prints.
 */
export interface CreatedCommentRecord extends CreatedComment {
  thread?: ThreadLocator;
}

/** {@link EditedComment} plus its thread, for the same reason. */
export interface EditedCommentRecord extends EditedComment {
  thread?: ThreadLocator;
}

/**
 * A comment this server deleted after a checkpoint. GitHub has no undelete, so
 * rollback can only report it — the body is kept so the receipt can say what
 * was lost without the host having to ask GitHub.
 */
export interface DeletedCommentRecord {
  repo: string;
  commentId: number;
  previousBody: string;
  review: boolean;
  thread?: ThreadLocator;
}

/**
 * Re-exported from types.ts, which WP9 made the home of the status so
 * {@link StateStore.checkpointStatus} could be declared on the one state seam.
 */
export type { CheckpointStatus };

/** {@link RollbackPlan} plus the deletes that cannot be undone at all. */
export interface CommentRollbackPlan extends RollbackPlan {
  created: CreatedCommentRecord[];
  edited: EditedCommentRecord[];
  deleted: DeletedCommentRecord[];
}

/**
 * The seam this package installs: {@link StateStore} widened by the two things
 * `types.ts` could not carry — the deletes (which rollback can only report) and
 * the richer plan {@link GithubState.rollback} returns. `ToolContext.state` is
 * typed `StateStore`, so the comment tools narrow to this; .9 installs
 * {@link GithubState} and nothing else implements it.
 */
export interface GithubStateStore extends StateStore {
  recordCreatedComment(comment: CreatedCommentRecord): void;
  recordEditedComment(comment: EditedCommentRecord): void;
  recordDeletedComment(comment: DeletedCommentRecord): void;
  rollback(checkpointId: string): CommentRollbackPlan | null;
  checkpointStatus(checkpointId: string): CheckpointStatus;
  snapshot(): GithubStateSnapshot;
}

/** The on-disk JSON: {@link StateSnapshot} plus `version` and the deletes. */
export interface GithubStateSnapshot extends StateSnapshot {
  version: number;
  created: Record<string, CreatedCommentRecord[]>;
  edited: Record<string, EditedCommentRecord[]>;
  deleted: Record<string, DeletedCommentRecord[]>;
}

export function emptySnapshot(): GithubStateSnapshot {
  return {
    version: STATE_VERSION,
    checkpoints: [],
    current: null,
    created: {},
    edited: {},
    deleted: {},
    lastPollAt: null,
    pollKeys: [],
    pollHeads: {},
  };
}

/**
 * The {@link StateStore} the tools and the poller see, over an in-memory
 * snapshot that {@link GithubState.flush} writes atomically.
 *
 * Without a state file the store still works for the life of the process and
 * `flush()` is a no-op (contract notes: GITHUB_STATE_FILE is optional).
 */
export class GithubState implements GithubStateStore {
  private snap: GithubStateSnapshot;
  /** Serializes flushes: two renames must not interleave. */
  private writing: Promise<void> = Promise.resolve();

  private constructor(
    readonly file: string | null,
    snap: GithubStateSnapshot,
    private readonly logger: Logger,
  ) {
    this.snap = snap;
  }

  /** A fresh store. `file` null keeps the state in memory only. */
  static empty(file: string | null = null, logger: Logger = silentLogger()): GithubState {
    return new GithubState(file, emptySnapshot(), logger);
  }

  /**
   * Load the state file, or start empty when it is absent, unreadable, not
   * JSON, or written by a version this build does not know. A damaged file is
   * never a startup failure: the bookkeeping is this server's own, and losing
   * it costs rollback reach, not host data. One stderr line names the file.
   */
  static load(file: string | null, logger: Logger = silentLogger()): GithubState {
    if (!file) return GithubState.empty(null, logger);
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'ENOENT') logger.warn(`state: cannot read ${file} (${code ?? 'error'}); starting empty`);
      return GithubState.empty(file, logger);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      logger.warn(`state: ${file} is not valid JSON; starting empty`);
      return GithubState.empty(file, logger);
    }
    const snap = normalize(parsed);
    if (!snap) {
      logger.warn(`state: ${file} is not a version ${STATE_VERSION} snapshot; starting empty`);
      return GithubState.empty(file, logger);
    }
    return new GithubState(file, snap, logger);
  }

  // ── Checkpoints (§8.2) ──

  createCheckpoint(): CheckpointRecord {
    const record: CheckpointRecord = {
      id: `chk_${randomUUID().slice(0, 8)}`,
      parent: this.snap.current,
      createdAt: new Date().toISOString(),
    };
    this.snap.checkpoints.push(record);
    this.snap.current = record.id;
    return record;
  }

  current(): string | null {
    return this.snap.current;
  }

  /** Every checkpoint, in creation order; `parent` carries the tree. */
  lineage(): CheckpointRecord[] {
    return this.snap.checkpoints.map((c) => ({ ...c }));
  }

  // ── Write bookkeeping ──

  recordCreatedComment(comment: CreatedCommentRecord): void {
    this.bucket(this.snap.created).push({ ...comment });
  }

  recordEditedComment(comment: EditedCommentRecord): void {
    this.bucket(this.snap.edited).push({ ...comment });
  }

  recordDeletedComment(comment: DeletedCommentRecord): void {
    this.bucket(this.snap.deleted).push({ ...comment });
  }

  private bucket<T>(store: Record<string, T[]>): T[] {
    const key = this.snap.current ?? ROOT_BUCKET;
    const list = store[key] ?? [];
    store[key] = list;
    return list;
  }

  // ── Rollback (§8.5) ──

  /**
   * Is `checkpointId` still rollable? See {@link CheckpointStatus}.
   */
  checkpointStatus(checkpointId: string): CheckpointStatus {
    if (!this.snap.checkpoints.some((c) => c.id === checkpointId)) return 'unknown';
    const parentOf = new Map(this.snap.checkpoints.map((c) => [c.id, c.parent]));
    for (let cursor = this.snap.current; cursor; cursor = parentOf.get(cursor) ?? null) {
      if (cursor === checkpointId) return 'live';
    }
    return 'abandoned';
  }

  /**
   * What undoing back to `checkpointId` means, newest action first, and null
   * when the checkpoint is not `live` — unknown, or abandoned by an earlier
   * rollback (the caller answers -32005, §8.7).
   *
   * Refusing an abandoned checkpoint is the honest answer, not a limitation
   * worth hiding: once a rollback moved `current` off a branch, that branch's
   * undo records are spent and this server keeps no redo records, so it cannot
   * put the comments back the way that checkpoint named them. Accepting it
   * would report a restoration that did not happen.
   *
   * The buckets consumed are the checkpoint's own and every descendant's; they
   * are cleared and `current` moves to the checkpoint, so the next write
   * branches from it (§8.2) and a second rollback to the same checkpoint is a
   * no-op rather than a double undo. An action the caller could not carry out
   * books itself again (it records under `current`, which is now the
   * checkpoint), so a retry sees it and cannot claim a completed rollback.
   */
  rollback(checkpointId: string): CommentRollbackPlan | null {
    if (this.checkpointStatus(checkpointId) !== 'live') return null;
    // Newest first: creation order reversed, so an edit that followed another
    // edit of the same comment is restored before the older body overwrites it.
    const ids = this.subtreeIds(checkpointId).reverse();
    const plan: CommentRollbackPlan = { created: [], edited: [], deleted: [] };
    for (const id of ids) {
      plan.created.push(...(this.snap.created[id] ?? []).slice().reverse());
      plan.edited.push(...(this.snap.edited[id] ?? []).slice().reverse());
      plan.deleted.push(...(this.snap.deleted[id] ?? []).slice().reverse());
      delete this.snap.created[id];
      delete this.snap.edited[id];
      delete this.snap.deleted[id];
    }
    this.snap.current = checkpointId;
    return plan;
  }

  /** `checkpointId` and every checkpoint descending from it, creation order. */
  private subtreeIds(checkpointId: string): string[] {
    const parentOf = new Map(this.snap.checkpoints.map((c) => [c.id, c.parent]));
    const inSubtree = (id: string): boolean => {
      for (let cursor: string | null = id; cursor; cursor = parentOf.get(cursor) ?? null) {
        if (cursor === checkpointId) return true;
      }
      return false;
    };
    return this.snap.checkpoints.filter((c) => inSubtree(c.id)).map((c) => c.id);
  }

  // ── Polling cursor and dedup ring (amendment 1) ──

  lastPollAt(): string | null {
    return this.snap.lastPollAt;
  }

  setLastPollAt(when: string): void {
    this.snap.lastPollAt = when;
  }

  seenPollKey(key: string): boolean {
    if (this.snap.pollKeys.includes(key)) return true;
    this.snap.pollKeys.push(key);
    if (this.snap.pollKeys.length > POLL_DEDUP_RING) {
      this.snap.pollKeys.splice(0, this.snap.pollKeys.length - POLL_DEDUP_RING);
    }
    return false;
  }

  polledHead(channel: string): string | null {
    return this.snap.pollHeads[channel] ?? null;
  }

  /**
   * Record a pull request's head sha, bounded by {@link POLL_HEAD_MEMORY}.
   *
   * Insertion order is the eviction order, so re-recording an unchanged head
   * deletes the key before setting it again: otherwise a long-lived pull
   * request polled every minute would keep its original (now oldest) slot and
   * be evicted ahead of heads nobody has looked at since.
   */
  setPolledHead(channel: string, sha: string): void {
    delete this.snap.pollHeads[channel];
    this.snap.pollHeads[channel] = sha;
    const keys = Object.keys(this.snap.pollHeads);
    for (const stale of keys.slice(0, Math.max(0, keys.length - POLL_HEAD_MEMORY))) {
      delete this.snap.pollHeads[stale];
    }
  }

  // ── Persistence ──

  snapshot(): GithubStateSnapshot {
    return structuredClone(this.snap);
  }

  /**
   * Write the snapshot atomically: a uniquely named temp file beside the state
   * file, fsync'd, then renamed over it. A crash before the rename leaves the
   * previous state file intact and a stray `.tmp-*` beside it, which
   * {@link GithubState.load} never reads; a crash after it leaves the new
   * state. No reader ever sees a half-written file.
   */
  async flush(): Promise<void> {
    const file = this.file;
    if (!file) return;
    const payload = `${JSON.stringify(this.snapshot(), null, 2)}\n`;
    const run = this.writing.then(async () => {
      const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
      mkdirSync(dirname(file), { recursive: true });
      const handle = await open(tmp, 'w', 0o600);
      try {
        await handle.writeFile(payload, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, file);
    });
    // Keep the chain alive past a failed write, but let the caller see the error.
    this.writing = run.catch(() => undefined);
    await run;
  }
}

/**
 * Accept a parsed state file only when it is this version and has the shape;
 * missing optional parts are filled in, anything else is rejected (null) so the
 * caller starts empty rather than running on a half-understood file.
 */
function normalize(parsed: unknown): GithubStateSnapshot | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const raw = parsed as Partial<GithubStateSnapshot>;
  if (raw.version !== STATE_VERSION) return null;
  if (!Array.isArray(raw.checkpoints)) return null;
  const snap = emptySnapshot();
  snap.checkpoints = raw.checkpoints.filter(
    (c): c is CheckpointRecord => !!c && typeof c.id === 'string' && typeof c.createdAt === 'string',
  );
  snap.current = typeof raw.current === 'string' ? raw.current : null;
  snap.created = buckets(raw.created);
  snap.edited = buckets(raw.edited);
  snap.deleted = buckets(raw.deleted);
  snap.lastPollAt = typeof raw.lastPollAt === 'string' ? raw.lastPollAt : null;
  snap.pollKeys = Array.isArray(raw.pollKeys) ? raw.pollKeys.filter((k): k is string => typeof k === 'string') : [];
  // Additive since amendment 2a, so a state file written before it is still a
  // valid version-1 snapshot: an absent map just means no head is known yet.
  snap.pollHeads = strings(raw.pollHeads);
  return snap;
}

/** A `Record<string, string>` from untrusted JSON; non-string values dropped. */
function strings(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

function buckets<T>(raw: unknown): Record<string, T[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, T[]> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(value)) out[key] = value as T[];
  }
  return out;
}
