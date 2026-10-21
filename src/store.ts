/**
 * Snapshot store: on-disk persistence for checkpoints, contexts and pending
 * confirmations, all rooted at `<workspace>/.dsh-checkpoint/`.
 *
 * Layout:
 *
 *   .dsh-checkpoint/
 *     drafts/<id>.json          draft checkpoint records
 *     checkpoints/<id>.json     confirmed checkpoint records
 *     contexts/<id>.json        serialized agent context (sidecar)
 *     diffs/<id>.patch          full diff, when it exceeded the inline cap
 *     confirmations/<id>.json   single-use two-phase confirmation tokens
 *     tmp-index                 scratch index used for tree capture
 *
 * The directory is added to `.gitignore` by `init_workspace`, so snapshot
 * metadata never pollutes the user's commit history.
 *
 * @module dsh-plugin-agent-checkpoint/store
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { CheckpointRecord, CheckpointRecord as CheckpointRecordType, PendingConfirmation, SessionContext } from './types.js';

/** Directory name of the store inside the workspace. */
export const STORE_DIRNAME = '.dsh-checkpoint';

/** Valid checkpoint id shape; also the traversal guard for path building. */
const ID_RE = /^(draft|ckpt)-\d{10,}-[a-z0-9]{4,12}$/;

export type StoreKind = 'drafts' | 'checkpoints' | 'contexts' | 'diffs' | 'confirmations' | 'aliases';

/** Absolute store root for a workspace. */
export function storeRoot(workspacePath: string): string {
  return path.join(workspacePath, STORE_DIRNAME);
}

/** Absolute path of a store sub-directory. */
export function storeSubdir(workspacePath: string, kind: StoreKind): string {
  return path.join(storeRoot(workspacePath), kind);
}

/** Create every store directory (idempotent). */
export async function ensureStore(workspacePath: string): Promise<string> {
  const root = storeRoot(workspacePath);
  for (const kind of [ 'drafts', 'checkpoints', 'contexts', 'diffs', 'confirmations', 'aliases' ] as const) {
    await mkdir(path.join(root, kind), { recursive: true });
  }
  return root;
}

/** Generate a sortable, collision-resistant checkpoint id. */
export function newCheckpointId(status: 'draft' | 'confirmed'): string {
  const prefix = status === 'draft' ? 'draft' : 'ckpt';
  const random = randomBytes(4).toString('hex');
  return `${prefix}-${Date.now()}-${random}`;
}

/** Assert an id is well-formed before it is used to build a path. */
export function assertCheckpointId(id: string): void {
  if (!ID_RE.test(id)) {
    throw new Error(`invalid checkpoint id: ${id}`);
  }
}

/** Atomic JSON write (tmp + rename) so a crash cannot leave a torn record. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    const text = await readFile(file, 'utf8');
    return JSON.parse(text) as T;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw new Error(`cannot read ${file}: ${(error as Error).message}`);
  }
}

/** Read a checkpoint record from either the draft or confirmed directory. */
export async function readCheckpoint(workspacePath: string, id: string): Promise<CheckpointRecord | null> {
  assertCheckpointId(id);
  if (id.startsWith('ckpt-')) {
    return await readJson<CheckpointRecord>(path.join(storeSubdir(workspacePath, 'checkpoints'), `${id}.json`));
  }
  return await readJson<CheckpointRecord>(path.join(storeSubdir(workspacePath, 'drafts'), `${id}.json`));
}

/**
 * Record a draft-id → confirmed-id alias.
 *
 * Confirmation replaces the draft record; keeping the alias means an operator
 * (or an agent holding an older id) can still preview or roll back by the draft
 * id they were given, and a second `confirm` attempt can report "already
 * confirmed" instead of a confusing "not found".
 */
export async function writeAlias(workspacePath: string, fromId: string, toId: string): Promise<void> {
  assertCheckpointId(fromId);
  assertCheckpointId(toId);
  await writeJsonAtomic(path.join(storeSubdir(workspacePath, 'aliases'), `${fromId}.json`), { id: toId });
}

/** Resolve an alias to its current id, or null. */
export async function readAlias(workspacePath: string, fromId: string): Promise<string | null> {
  if (!ID_RE.test(fromId)) return null;
  const record = await readJson<{ id?: string }>(path.join(storeSubdir(workspacePath, 'aliases'), `${fromId}.json`));
  return record && typeof record.id === 'string' && ID_RE.test(record.id) ? record.id : null;
}

/** All alias entries, for id-prefix searches. */
async function listAliases(workspacePath: string): Promise<Array<{ from: string; to: string }>> {
  const dir = storeSubdir(workspacePath, 'aliases');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ from: string; to: string }> = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const from = entry.slice(0, -'.json'.length);
    const record = await readJson<{ id?: string }>(path.join(dir, entry)).catch(() => null);
    if (record && typeof record.id === 'string') out.push({ from, to: record.id });
  }
  return out;
}

/** Resolve an id (or unique fragment, or alias) to a live checkpoint record. */
export async function resolveCheckpoint(
  workspacePath: string,
  partial: string,
): Promise<{ id: string; record: CheckpointRecordType }> {
  const trimmed = partial.trim();
  if (ID_RE.test(trimmed)) {
    const direct = await readCheckpoint(workspacePath, trimmed);
    if (direct) return { id: trimmed, record: direct };
    const alias = await readAlias(workspacePath, trimmed);
    if (alias) {
      const aliased = await readCheckpoint(workspacePath, alias);
      if (aliased) return { id: alias, record: aliased };
    }
    throw new Error(`no checkpoint with id "${trimmed}" (it may have been trimmed by the draft retention limit)`);
  }

  const all = [ ...(await listRecords(workspacePath, 'drafts')), ...(await listRecords(workspacePath, 'checkpoints')) ];
  const matches = all.filter((record) => record.id.includes(trimmed));
  if (matches.length === 1) return { id: matches[0]!.id, record: matches[0]! };
  if (matches.length > 1) {
    throw new Error(
      `checkpoint id "${partial}" is ambiguous; matches:\n${matches.map((record) => `- ${record.id} (${record.title})`).join('\n')}`,
    );
  }
  const aliasMatches = (await listAliases(workspacePath)).filter((entry) => entry.from.includes(trimmed));
  for (const aliasEntry of aliasMatches) {
    const aliased = await readCheckpoint(workspacePath, aliasEntry.to);
    if (aliased) return { id: aliasEntry.to, record: aliased };
  }
  throw new Error(`no checkpoint matches "${partial}"`);
}

/**
 * Resolve a checkpoint id that may be abbreviated to its unique substring.
 * Returns the full id, or throws a message listing ambiguous matches.
 */
export async function resolveCheckpointId(workspacePath: string, partial: string): Promise<string> {
  return (await resolveCheckpoint(workspacePath, partial)).id;
}

/** Write a draft record. */
export async function writeDraft(workspacePath: string, record: CheckpointRecord): Promise<void> {
  assertCheckpointId(record.id);
  await writeJsonAtomic(path.join(storeSubdir(workspacePath, 'drafts'), `${record.id}.json`), record);
}

/** Write a confirmed record. */
export async function writeConfirmed(workspacePath: string, record: CheckpointRecord): Promise<void> {
  assertCheckpointId(record.id);
  await writeJsonAtomic(path.join(storeSubdir(workspacePath, 'checkpoints'), `${record.id}.json`), record);
}

/** Promote a draft record to the confirmed directory, removing the draft copy. */
export async function promoteDraft(workspacePath: string, record: CheckpointRecord): Promise<void> {
  assertCheckpointId(record.id);
  await writeConfirmed(workspacePath, record);
  await rm(path.join(storeSubdir(workspacePath, 'drafts'), `${record.id}.json`), { force: true });
}

/** Save the sidecar agent context for a checkpoint. */
export async function writeContext(workspacePath: string, id: string, context: SessionContext): Promise<string> {
  assertCheckpointId(id);
  const file = path.join(storeSubdir(workspacePath, 'contexts'), `${id}.json`);
  await writeJsonAtomic(file, context);
  return file;
}

/** Read the sidecar agent context for a checkpoint, when present. */
export async function readContext(workspacePath: string, id: string): Promise<SessionContext | null> {
  assertCheckpointId(id);
  return await readJson<SessionContext>(path.join(storeSubdir(workspacePath, 'contexts'), `${id}.json`));
}

/** Write the full diff patch when it is too large to inline. */
export async function writeDiffPatch(workspacePath: string, id: string, diff: string): Promise<string> {
  assertCheckpointId(id);
  const file = path.join(storeSubdir(workspacePath, 'diffs'), `${id}.patch`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, diff, 'utf8');
  return file;
}

/** List and parse every record in one of the checkpoint directories. */
export async function listRecords(
  workspacePath: string,
  kind: 'drafts' | 'checkpoints',
): Promise<CheckpointRecord[]> {
  const dir = storeSubdir(workspacePath, kind);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const records: CheckpointRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const record = await readJson<CheckpointRecord>(path.join(dir, entry)).catch(() => null);
    if (record && typeof record.id === 'string') records.push(record);
  }
  records.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return records;
}

/** All checkpoints (drafts + confirmed), newest first. */
export async function listAllCheckpoints(workspacePath: string): Promise<CheckpointRecord[]> {
  const [ drafts, confirmed ] = await Promise.all([
    listRecords(workspacePath, 'drafts'),
    listRecords(workspacePath, 'checkpoints'),
  ]);
  return [ ...drafts, ...confirmed ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

/** Remove a draft record and its sidecars (used by retention trimming). */
export async function removeDraft(workspacePath: string, id: string): Promise<void> {
  assertCheckpointId(id);
  await Promise.all([
    rm(path.join(storeSubdir(workspacePath, 'drafts'), `${id}.json`), { force: true }),
    rm(path.join(storeSubdir(workspacePath, 'contexts'), `${id}.json`), { force: true }),
    rm(path.join(storeSubdir(workspacePath, 'diffs'), `${id}.patch`), { force: true }),
  ]);
}

/**
 * Trim the draft backlog down to `maxDraftCount`, oldest first.
 *
 * Confirmed checkpoints are never trimmed: the requirement document states the
 * MVP exposes no snapshot deletion, so confirmed history stays intact.
 */
export async function trimDrafts(
  workspacePath: string,
  maxDraftCount: number,
  protectedId?: string,
): Promise<CheckpointRecord[]> {
  const drafts = await listRecords(workspacePath, 'drafts');
  const removable = drafts.filter((record) => record.id !== protectedId);
  const excess = removable.length + (protectedId ? 1 : 0) - maxDraftCount;
  if (excess <= 0) return [];
  const removed = removable.slice(-excess);
  for (const record of removed) {
    await removeDraft(workspacePath, record.id);
  }
  return removed;
}

/** Persist a pending confirmation token. */
export async function writePendingConfirmation(workspacePath: string, pending: PendingConfirmation): Promise<string> {
  const file = path.join(storeSubdir(workspacePath, 'confirmations'), `${pending.id}.json`);
  await writeJsonAtomic(file, pending);
  return file;
}

/** Read a pending confirmation token without consuming it. */
export async function readPendingConfirmation(
  workspacePath: string,
  id: string,
): Promise<PendingConfirmation | null> {
  if (!/^cfm-[0-9a-f]{16,64}$/.test(id)) return null;
  return await readJson<PendingConfirmation>(path.join(storeSubdir(workspacePath, 'confirmations'), `${id}.json`));
}

/** Delete a confirmation token (single use). */
export async function consumePendingConfirmation(workspacePath: string, id: string): Promise<void> {
  if (!/^cfm-[0-9a-f]{16,64}$/.test(id)) return;
  await rm(path.join(storeSubdir(workspacePath, 'confirmations'), `${id}.json`), { force: true });
}

/** Drop expired confirmation tokens; returns how many were removed. */
export async function purgeExpiredConfirmations(workspacePath: string, now: number = Date.now()): Promise<number> {
  const dir = storeSubdir(workspacePath, 'confirmations');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const file = path.join(dir, entry);
    const info = await stat(file).catch(() => null);
    if (!info) continue;
    const pending = await readJson<PendingConfirmation>(file).catch(() => null);
    const expiresAt = pending ? Date.parse(pending.expiresAt) : info.mtimeMs + 600_000;
    if (Number.isFinite(expiresAt) && expiresAt < now) {
      await rm(file, { force: true });
      removed += 1;
    }
  }
  return removed;
}

/** Scratch index path used by the tree-capture routine. */
export function scratchIndexPath(workspacePath: string): string {
  return path.join(storeRoot(workspacePath), 'tmp-index');
}
