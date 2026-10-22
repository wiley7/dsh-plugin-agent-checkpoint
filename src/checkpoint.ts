/**
 * Checkpoint service: the business logic behind every MCP tool.
 *
 * Keeping this layer free of MCP types means the whole feature set is directly
 * unit-testable with a temp directory and a real git binary.
 *
 * The two invariants the requirement document calls out are enforced here, not
 * in the transport layer:
 *
 * 1. **High-risk operations require explicit human approval.** `confirm` and
 *    `rollback` refuse to act unless they receive a single-use confirmation
 *    token that was minted by a previous call and is bound to the exact payload
 *    (see {@link CheckpointService.issueConfirmation}).
 * 2. **Conflicts abort instead of resolving.** Every destructive path checks the
 *    working tree first and returns the conflict list instead of forcing a
 *    three-way merge.
 *
 * @module dsh-plugin-agent-checkpoint/checkpoint
 */

import { createHash, randomBytes } from 'node:crypto';
import { access, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { CONFIG_FILENAME, loadConfig, type LoadedConfig } from './config.js';
import * as g from './git.js';
import { captureSessionContext, renderContextSummary } from './session.js';
import {
  assertCheckpointId,
  ensureStore,
  listAllCheckpoints,
  listRecords,
  newCheckpointId,
  purgeExpiredConfirmations,
  readCheckpoint,
  resolveCheckpoint,
  readContext,
  readPendingConfirmation,
  removeDraft,
  resolveCheckpointId,
  scratchIndexPath,
  storeRoot,
  storeSubdir,
  trimDrafts,
  writeAlias,
  writeConfirmed,
  writeContext,
  writeDiffPatch,
  writeDraft,
  writePendingConfirmation,
  consumePendingConfirmation,
} from './store.js';
import type {
  CheckpointConfig,
  CheckpointRecord,
  FileChange,
  PendingConfirmation,
  RepoStatus,
  SessionContext,
} from './types.js';

/**
 * Resolve a path through symlinks, falling back to the literal path.
 *
 * macOS exposes `/var` as a symlink to `/private/var`, and `git rev-parse
 * --show-toplevel` always reports the canonical form. Comparing the raw paths
 * would make every workspace under a temp dir look like it lives "inside" a
 * repository it actually *is*.
 */
async function canonicalPath(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

/** True when both paths point at the same directory (after symlink resolution). */
async function samePath(a: string, b: string): Promise<boolean> {
  if (path.resolve(a) === path.resolve(b)) return true;
  return (await canonicalPath(a)) === (await canonicalPath(b));
}

/** Marker line written to `.gitignore` by `init_workspace`. */
const GITIGNORE_ENTRIES = [
  '.dsh-checkpoint/',
  'node_modules/',
  'dist/',
  'build/',
  '.env',
  '.env.local',
  '*.log',
  '.DS_Store',
];

/** Prefix for the plugin's own ref namespace, anchoring snapshot objects. */
const REF_PREFIX = 'refs/dsh-checkpoint';

/** Structured, tool-facing error. */
export class CheckpointError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CheckpointError';
    this.code = code;
    this.details = details;
  }
}

export interface InitResult {
  workspace: string;
  gitAvailable: boolean;
  gitVersion: string | null;
  created: boolean;
  branch: string | null;
  head: string | null;
  gitignoreUpdated: boolean;
  excludeUpdated: boolean;
  identity: { configured: string[] };
  config: CheckpointConfig;
  configPath: string;
  configFound: boolean;
  storePath: string;
  warnings: string[];
  nextSteps: string[];
}

export interface DraftResult {
  draftId: string;
  status: 'draft';
  title: string;
  tags: string[];
  remark: string;
  workspace: string;
  branch: string | null;
  baseCommit: string | null;
  treeHash: string;
  files: FileChange[];
  filesChanged: number;
  diffStat: string;
  contextSummary: string;
  contextBytes: number;
  contextPath: string;
  sessionId: string | null;
  trimmedDrafts: string[];
  warnings: string[];
  /** How the operator turns this draft into a real commit. */
  next: string;
}

export interface PreviewResult {
  checkpoint: CheckpointRecord;
  diff: string;
  diffTruncated: boolean;
  context: SessionContext | null;
  contextDigest: string;
}

export interface ConfirmationChallenge {
  status: 'confirmation_required';
  confirmationId: string;
  action: PendingConfirmation['action'];
  expiresAt: string;
  ttlSeconds: number;
  summary: string;
  details: Record<string, unknown>;
  message: string;
}

export interface ConfirmResult {
  status: 'confirmed';
  checkpointId: string;
  draftId: string;
  commitHash: string;
  commitMessage: string;
  branch: string | null;
  filesChanged: number;
  contextPath: string;
  confirmedAt: string;
}

export interface ConflictReport {
  status: 'conflict';
  reason: string;
  message: string;
  conflicts: {
    /** Tracked files modified since the snapshot. */
    modified?: FileChange[];
    /** Untracked files that would be overwritten. */
    untracked?: string[];
    /** Files that differ between the snapshot and the current work tree. */
    files?: FileChange[];
    headMoved?: { expected: string | null; actual: string | null };
  };
  resolution: string[];
}

export interface RollbackResult {
  status: 'rolled_back';
  checkpointId: string;
  checkpointTitle: string;
  restoredFrom: { commitHash: string | null; treeHash: string | null };
  branchMoved: boolean;
  filesRestored: number;
  contextPath: string;
  contextDigest: string;
  restoredPlan: { content: string; status: string }[];
  /** Instruction for the agent: how to re-hydrate the restored context. */
  rehydration: string;
  warnings: string[];
}

export interface ListEntry {
  id: string;
  status: 'draft' | 'confirmed';
  title: string;
  tags: string[];
  createdAt: string;
  remark: string;
  commitHash: string | null;
  branch: string | null;
  filesChanged: number;
  contextSummary: string;
}

export interface StatusResult {
  workspace: string;
  repo: RepoStatus;
  store: { path: string; exists: boolean; drafts: number; confirmed: number };
  config: CheckpointConfig;
  configFile: { path: string; found: boolean; warnings: string[] };
  lastCheckpoint: { id: string; title: string; status: string; createdAt: string; commitHash: string | null } | null;
  git: { available: boolean; version: string | null };
  pendingConfirmations: number;
  hints: string[];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Deterministic JSON so the same payload always hashes the same. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([ left ], [ right ]) => left.localeCompare(right));
  return `{${entries.map(([ key, entry ]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the repository ignores the snapshot store.
 *
 * Two belts: `.gitignore` (shared, committed by the user) and
 * `.git/info/exclude` (local, never committed). Both are additive and preserve
 * existing content.
 */
async function ensureIgnoreRules(
  workspacePath: string,
  patterns: string[],
  gitDirPath: string,
): Promise<{ gitignoreUpdated: boolean; excludeUpdated: boolean }> {
  const gitignorePath = path.join(workspacePath, '.gitignore');
  let existing = '';
  try {
    existing = await readFile(gitignorePath, 'utf8');
  } catch {
    existing = '';
  }
  const present = new Set(
    existing
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#')),
  );
  const missing = GITIGNORE_ENTRIES.filter((entry) => !present.has(entry));
  let gitignoreUpdated = false;
  if (missing.length > 0) {
    const header = existing.trim().length === 0 ? '' : '\n# dsh-agent-checkpoint\n';
    const body = existing.trim().length === 0 ? '# dsh-agent-checkpoint\n' : '';
    await writeFile(gitignorePath, `${existing.replace(/\s+$/, '')}${header}${body}${missing.join('\n')}\n`, 'utf8');
    gitignoreUpdated = true;
  }

  const excludePatterns = [ '.dsh-checkpoint', ...patterns ]
    .map((entry) => entry.replace(/^\/+|\/+$/g, ''))
    .filter((entry) => entry.length > 0);
  const unique = [ ...new Set(excludePatterns) ];
  const { changed } = await g.writeExcludeBlock(gitDirPath, unique);
  return { gitignoreUpdated, excludeUpdated: changed };
}

/** Service bound to one workspace at a time. */
export class CheckpointService {
  #workspace: string;

  constructor(workspacePath: string) {
    this.#workspace = path.resolve(workspacePath);
  }

  /** Current workspace path. */
  get workspace(): string {
    return this.#workspace;
  }

  /** Switch the workspace this service operates on. */
  useWorkspace(workspacePath: string): string {
    this.#workspace = path.resolve(workspacePath);
    return this.#workspace;
  }

  /** Load policy config for the current workspace. */
  async config(): Promise<LoadedConfig> {
    return await loadConfig(this.#workspace);
  }

  /**
   * Initialise (or verify) a git repository for `workspacePath`.
   *
   * Idempotent: running it twice only re-applies ignore rules and reports the
   * existing state, which makes it safe to call at the start of any session.
   */
  async initWorkspace(workspacePath: string): Promise<InitResult> {
    const target = path.resolve(workspacePath);
    await g.ensureDirectory(target);
    const capsOut = await g.capabilities();
    if (!capsOut.available) {
      throw new CheckpointError(
        'git_unavailable',
        'git is not installed or not on PATH; dsh-agent-checkpoint requires the system git binary',
      );
    }
    const warnings: string[] = [];
    const loaded = await loadConfig(target);

    const existingTop = await g.topLevel(target);
    let created = false;
    if (existingTop && !(await samePath(existingTop, target))) {
      throw new CheckpointError(
        'nested_repository',
        `${target} is inside the git repository at ${existingTop}; point the plugin at the repository root instead`,
        { repositoryRoot: existingTop },
      );
    }
    if (!existingTop) {
      const initResult = await g.initRepo(target);
      created = initResult.created;
      warnings.push(`initialised a new git repository at ${target}`);
    }

    const gitDirPath = await g.gitDir(target);
    if (!gitDirPath) {
      throw new CheckpointError('git_init_failed', `could not determine the git directory for ${target}`);
    }

    const ignore = await ensureIgnoreRules(target, loaded.config.ignore_patterns, gitDirPath);
    const identity = await g.ensureIdentity(target);
    warnings.push(...identity.warnings);

    await ensureStore(target);
    this.#workspace = target;

    const branch = await g.currentBranch(target);
    const head = await g.headHash(target);
    if (loaded.warnings.length > 0) warnings.push(...loaded.warnings);

    const nextSteps: string[] = [];
    if (!head) {
      nextSteps.push(
        `the repository has no commits yet; the first confirmed checkpoint will create the root commit (base tree: ${g.EMPTY_TREE.slice(0, 12)}…)`,
      );
    }
    nextSteps.push('call create_draft_checkpoint at a milestone to capture files + agent context');
    nextSteps.push('confirm_checkpoint requires an operator-approved confirmation id before it commits');

    return {
      workspace: target,
      gitAvailable: true,
      gitVersion: capsOut.version,
      created,
      branch,
      head,
      gitignoreUpdated: ignore.gitignoreUpdated,
      excludeUpdated: ignore.excludeUpdated,
      identity: { configured: identity.configured },
      config: loaded.config,
      configPath: loaded.path,
      configFound: loaded.found,
      storePath: storeRoot(target),
      warnings,
      nextSteps,
    };
  }

  /** Make sure the current workspace is a usable repository. */
  async #ensureRepo(): Promise<{ gitDirPath: string; branch: string | null; head: string | null }> {
    const top = await g.topLevel(this.#workspace);
    if (!top) {
      throw new CheckpointError(
        'not_a_git_repo',
        `${this.#workspace} is not a git repository; call init_workspace first`,
        { workspace: this.#workspace },
      );
    }
    if (!(await samePath(top, this.#workspace))) {
      throw new CheckpointError(
        'workspace_not_repository_root',
        `workspace ${this.#workspace} is inside the repository at ${top}; use the repository root`,
        { repositoryRoot: top },
      );
    }
    const gitDirPath = await g.gitDir(top);
    if (!gitDirPath) {
      throw new CheckpointError('git_init_failed', `could not determine the git directory for ${top}`);
    }
    return { gitDirPath, branch: await g.currentBranch(top), head: await g.headHash(top) };
  }

  /**
   * Resolve a caller-supplied checkpoint reference into a live record.
   *
   * Accepts a full id, a unique id fragment, or a draft id that has since been
   * promoted to a confirmed checkpoint (see the alias table in the store).
   */
  async #requireRecord(reference: string): Promise<{ id: string; record: CheckpointRecord }> {
    try {
      return await resolveCheckpoint(this.#workspace, reference);
    } catch (error) {
      throw new CheckpointError('checkpoint_not_found', (error as Error).message, { reference });
    }
  }

  /**
   * Capture a milestone draft: working-tree state + serialized agent context.
   *
   * No commit is created and HEAD does not move; the tree is stored as a
   * dangling commit object anchored by `refs/dsh-checkpoint/<id>` so garbage
   * collection cannot prune it before the operator confirms or discards it.
   */
  async createDraft(input: {
    title?: string;
    tags?: string[];
    remark?: string;
    sessionId?: string | null;
    sessionFile?: string | null;
  }): Promise<DraftResult> {
    const workspace = this.#workspace;
    const warnings: string[] = [];
    const loaded = await loadConfig(workspace);
    const config = loaded.config;
    if (loaded.warnings.length > 0) warnings.push(...loaded.warnings);

    const repo = await this.#ensureRepo();
    await ensureStore(workspace);
    const identity = await g.ensureIdentity(workspace);
    warnings.push(...identity.warnings);
    await ensureIgnoreRules(workspace, config.ignore_patterns, repo.gitDirPath);

    const title = input.title?.trim() || `draft ${new Date().toISOString()}`;
    const tags = [ ...new Set((input.tags ?? []).map((tag) => tag.trim()).filter((tag) => tag.length > 0)) ];
    const remark = input.remark?.trim() ?? '';

    const capture = await captureSessionContext({
      workspacePath: workspace,
      sessionId: input.sessionId ?? process.env.DSH_SESSION_ID ?? null,
      sessionFile: input.sessionFile ?? null,
      limits: {
        maxMessageChars: config.max_context_message_chars,
        maxMessages: config.max_context_messages,
        maxBytes: config.max_context_bytes,
      },
    });
    warnings.push(...capture.warnings);
    const context = capture.context;

    const treeHash = await g.writeWorktreeTree(workspace, scratchIndexPath(workspace));
    const baseCommit = repo.head;
    const diffBase = baseCommit ?? g.EMPTY_TREE;
    const files = await g.changedFilesBetween(workspace, diffBase, treeHash);
    const diffStat = (await g.diffBetween(workspace, diffBase, treeHash, { stat: true })).trim();
    let diff = await g.diffBetween(workspace, diffBase, treeHash, { maxChars: config.max_diff_chars });
    let diffTruncated = diff.includes('[diff truncated at');

    const contextIsEmpty = context.messages.length === 0 && context.plan.length === 0;
    if (files.length === 0 && contextIsEmpty) {
      throw new CheckpointError(
        'nothing_to_checkpoint',
        'no file changes and no agent context were found, so this draft would be empty',
        { workspace, baseCommit },
      );
    }
    if (files.length === 0) {
      warnings.push('no file changes were captured; this draft records agent context only');
    }

    const id = newCheckpointId('draft');
    const parents = baseCommit ? [ baseCommit ] : [];
    const draftCommit = await g.commitObject(
      workspace,
      treeHash,
      parents,
      [
        `dsh-agent-checkpoint draft: ${title}`,
        '',
        'Snapshot object created without touching HEAD.',
        `id: ${id}`,
      ].join('\n'),
    );
    const anchorRef = `${REF_PREFIX}/drafts/${id}`;
    await g.updateRef(workspace, anchorRef, draftCommit);

    const contextPath = await writeContext(workspace, id, context);
    let diffPath: string | null = null;
    if (diffTruncated) {
      const fullDiff = await g.diffBetween(workspace, diffBase, treeHash);
      diffPath = await writeDiffPatch(workspace, id, fullDiff);
    }

    const now = new Date().toISOString();
    const record: CheckpointRecord = {
      id,
      status: 'draft',
      title,
      tags,
      remark,
      createdAt: now,
      updatedAt: now,
      workspace,
      branch: repo.branch,
      baseCommit,
      treeHash,
      draftCommit,
      commitHash: null,
      parentCommit: baseCommit,
      files,
      diffStat,
      diff,
      diffTruncated,
      diffPath,
      contextPath,
      contextSummary: renderContextSummary(context),
      sessionId: context.sessionId,
      anchorRef,
    };
    await writeDraft(workspace, record);

    const trimmed = await trimDrafts(workspace, config.max_draft_count, id);
    if (trimmed.length > 0) {
      for (const recordToDrop of trimmed) {
        await g.deleteRef(workspace, recordToDrop.anchorRef).catch(() => undefined);
      }
      warnings.push(
        `draft retention limit (max_draft_count=${config.max_draft_count}) removed ${trimmed.length} older draft(s): ${trimmed
          .map((entry) => entry.id)
          .join(', ')}`,
      );
    }

    return {
      draftId: id,
      status: 'draft',
      title,
      tags,
      remark,
      workspace,
      branch: repo.branch,
      baseCommit,
      treeHash,
      files,
      filesChanged: files.length,
      diffStat,
      contextSummary: record.contextSummary,
      contextBytes: context.bytes,
      contextPath,
      sessionId: context.sessionId,
      trimmedDrafts: trimmed.map((entry) => entry.id),
      warnings,
      next: `preview with preview_checkpoint {checkpoint_id:"${id}"}; to commit, ask the operator and then call confirm_checkpoint {draft_id:"${id}", commit_message:"…", confirmation_id:"<issued token>"}`,
    };
  }

  /** Full preview: metadata, unified diff and context digest. */
  async previewCheckpoint(input: { checkpointId: string; includeDiff?: boolean; maxDiffChars?: number }): Promise<PreviewResult> {
    const { id, record } = await this.#requireRecord(input.checkpointId);
    await ensureStore(this.#workspace);

    let diff = '';
    if (input.includeDiff !== false) {
      const cap = Math.max(1_000, input.maxDiffChars ?? 12_000);
      if (!record.diffTruncated) {
        diff = truncate(record.diff, cap);
      } else if (record.diffPath) {
        const full = await readFile(record.diffPath, 'utf8').catch(() => '');
        diff = truncate(full, cap);
      } else {
        diff = truncate(record.diff, cap);
      }
    }
    const context = await readContext(this.#workspace, id);
    return {
      checkpoint: record,
      diff,
      diffTruncated: record.diffTruncated,
      context,
      contextDigest: context ? renderContextSummary(context) : record.contextSummary,
    };
  }

  /**
   * Mint a single-use confirmation token bound to `action` + `payload`.
   *
   * The token is what turns "the agent thinks the user agreed" into "the user
   * actually agreed": the tool call that performs the destructive action must
   * present it, and the payload hash makes a swapped draft id or commit message
   * detectable.
   */
  async issueConfirmation(
    action: PendingConfirmation['action'],
    payload: Record<string, unknown>,
    summary: string,
    details: Record<string, unknown>,
    config: CheckpointConfig,
  ): Promise<ConfirmationChallenge> {
    await ensureStore(this.#workspace);
    await purgeExpiredConfirmations(this.#workspace);
    const now = Date.now();
    const ttlMs = config.confirmation_ttl_seconds * 1000;
    const pending: PendingConfirmation = {
      id: `cfm-${randomBytes(16).toString('hex')}`,
      action,
      payloadHash: sha256(canonicalJson({ action, payload })),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString(),
      summary,
      details,
    };
    await writePendingConfirmation(this.#workspace, pending);
    return {
      status: 'confirmation_required',
      confirmationId: pending.id,
      action,
      expiresAt: pending.expiresAt,
      ttlSeconds: config.confirmation_ttl_seconds,
      summary,
      details,
      message: truncate(
        `This action is high risk and was NOT executed. Show the operator exactly what it will do: ${summary}\n\n` +
          `If — and only if — they explicitly approve, call the same tool again with confirmation_id="${pending.id}" within ${config.confirmation_ttl_seconds}s. ` +
          'Do not approve on their behalf and do not invent a confirmation id.',
        2000,
      ),
    };
  }

  /** Validate and consume a confirmation token for `action` + `payload`. */
  async #requireConfirmation(
    confirmationId: string,
    action: PendingConfirmation['action'],
    payload: Record<string, unknown>,
  ): Promise<PendingConfirmation> {
    const pending = await readPendingConfirmation(this.#workspace, confirmationId);
    if (!pending) {
      throw new CheckpointError(
        'invalid_confirmation',
        `confirmation id ${confirmationId} is unknown, already used, or expired; call the tool without confirmation_id to request a fresh one`,
      );
    }
    if (pending.action !== action) {
      throw new CheckpointError(
        'invalid_confirmation',
        `confirmation id ${confirmationId} was issued for ${pending.action}, not ${action}`,
      );
    }
    if (Date.parse(pending.expiresAt) < Date.now()) {
      await consumePendingConfirmation(this.#workspace, confirmationId);
      throw new CheckpointError(
        'confirmation_expired',
        `confirmation id ${confirmationId} expired at ${pending.expiresAt}; request a new one`,
      );
    }
    const expected = sha256(canonicalJson({ action, payload }));
    if (pending.payloadHash !== expected) {
      throw new CheckpointError(
        'confirmation_mismatch',
        'the request differs from the one the operator approved (draft id, commit message, or checkpoint changed); showing the new request to the operator is required',
        { issuedPayloadHash: pending.payloadHash, receivedPayloadHash: expected },
      );
    }
    return pending;
  }

  /**
   * Turn a draft into a real commit — the only path that writes history.
   *
   * Guards, in order:
   * 1. the confirmation token must exist and match this exact draft + message;
   * 2. HEAD must still be the draft's base commit (no rebase/amend in between);
   * 3. the working tree must still match the captured tree, otherwise the draft
   *    no longer describes what would be committed and a conflict is returned.
   */
  async confirmCheckpoint(input: {
    draftId: string;
    commitMessage?: string;
    confirmationId?: string;
    sessionId?: string | null;
  }): Promise<ConfirmResult | ConfirmationChallenge | ConflictReport> {
    const loaded = await loadConfig(this.#workspace);
    const config = loaded.config;
    const { id, record } = await this.#requireRecord(input.draftId);
    if (record.status !== 'draft') {
      throw new CheckpointError('already_confirmed', `${id} is already a confirmed checkpoint (commit ${record.commitHash})`);
    }
    const commitMessage = (input.commitMessage ?? '').trim() || record.title || `checkpoint: ${id}`;
    const payload = { draftId: id, commitMessage };

    if (!input.confirmationId) {
      const summary =
        `git commit on branch "${record.branch ?? '(detached)'}" with message "${truncate(commitMessage, 160)}" ` +
        `covering ${record.files.length} file(s) (base ${record.baseCommit?.slice(0, 12) ?? 'no-commit'} → draft ${record.treeHash?.slice(0, 12) ?? 'n/a'})`;
      return await this.issueConfirmation('confirm_checkpoint', payload, summary, {
        draftId: id,
        title: record.title,
        tags: record.tags,
        branch: record.branch,
        files: record.files,
        diffStat: record.diffStat,
      }, config);
    }

    const pending = await this.#requireConfirmation(input.confirmationId, 'confirm_checkpoint', payload);

    const result = await this.#commitDraft(record, commitMessage);
    if (result.status === 'confirmed') await consumePendingConfirmation(this.#workspace, pending.id);
    return result;
  }

  /**
   * Commit a draft the operator already opted into from Settings.
   *
   * This skips the two-phase token on purpose: the operator turned commits on
   * in the settings card, which is the approval. Everything a confirmation
   * would protect still applies — HEAD must not have moved and the working tree
   * must match the captured tree — and a mismatch returns a conflict report
   * without writing history.
   */
  async commitDraftAutomatically(input: {
    draftId: string;
    commitMessage?: string;
  }): Promise<ConfirmResult | ConflictReport> {
    const { id, record } = await this.#requireRecord(input.draftId);
    if (record.status !== 'draft') {
      throw new CheckpointError('already_confirmed', `${id} is already a confirmed checkpoint (commit ${record.commitHash})`);
    }
    const commitMessage = (input.commitMessage ?? '').trim() || record.title || `checkpoint: ${id}`;
    return await this.#commitDraft(record, commitMessage);
  }

  /**
   * Shared commit pipeline: the guards both confirm paths rely on.
   * @param record - the draft record to promote.
   * @param commitMessage - the message for the new commit.
   * @returns the confirmed checkpoint, or a conflict report.
   */
  async #commitDraft(record: CheckpointRecord, commitMessage: string): Promise<ConfirmResult | ConflictReport> {
    const repo = await this.#ensureRepo();
    if ((repo.head ?? null) !== (record.baseCommit ?? null)) {
      return {
        status: 'conflict',
        reason: 'head_moved',
        message:
          'HEAD changed since this draft was captured, so committing it would mix unrelated history. Create a new draft instead.',
        conflicts: { headMoved: { expected: record.baseCommit, actual: repo.head } },
        resolution: [ 'create_draft_checkpoint again on the current HEAD', 'or discard this draft by creating a newer one (drafts are never auto-committed)' ],
      };
    }

    const currentTree = await g.writeWorktreeTree(this.#workspace, scratchIndexPath(this.#workspace));
    if (record.treeHash && currentTree !== record.treeHash) {
      const drift = await g.changedFilesBetween(this.#workspace, record.treeHash, currentTree);
      return {
        status: 'conflict',
        reason: 'worktree_changed',
        message: 'the working tree changed after the draft was captured, so this draft no longer describes what would be committed',
        conflicts: { files: drift },
        resolution: [ 'create_draft_checkpoint again to capture the current state', 'or revert the listed files to the draft state, then retry' ],
      };
    }

    const commitHash = await g.commitAll(this.#workspace, commitMessage);
    const confirmedId = newCheckpointId('confirmed');
    const now = new Date().toISOString();

    // Move the sidecars to the new id before the draft directory entry (and its
    // context/patch files) is deleted, so nothing is lost in between.
    const context = await readContext(this.#workspace, record.id);
    const confirmed: CheckpointRecord = {
      ...record,
      id: confirmedId,
      status: 'confirmed',
      updatedAt: now,
      commitHash,
      parentCommit: record.baseCommit,
      anchorRef: `${REF_PREFIX}/checkpoints/${confirmedId}`,
    };
    confirmed.contextPath = context
      ? await writeContext(this.#workspace, confirmedId, context)
      : record.contextPath;
    if (record.diffPath) {
      const fullDiff = await readFile(record.diffPath, 'utf8').catch(() => '');
      confirmed.diffPath = fullDiff.length > 0 ? await writeDiffPatch(this.#workspace, confirmedId, fullDiff) : null;
    }
    await writeConfirmed(this.#workspace, confirmed);
    await removeDraft(this.#workspace, record.id);
    await g.updateRef(this.#workspace, confirmed.anchorRef, commitHash);
    await g.deleteRef(this.#workspace, record.anchorRef).catch(() => undefined);
    await writeAlias(this.#workspace, record.id, confirmedId);

    return {
      status: 'confirmed',
      checkpointId: confirmedId,
      draftId: record.id,
      commitHash,
      commitMessage,
      branch: repo.branch,
      filesChanged: record.files.length,
      contextPath: confirmed.contextPath,
      confirmedAt: now,
    };
  }

  /**
   * Restore working-tree files (and re-expose the captured context).
   *
   * Conflict policy: any uncommitted change aborts the rollback and returns the
   * conflict list, because silently discarding the operator's work is worse than
   * failing the tool call.
   */
  async rollbackCheckpoint(input: {
    checkpointId: string;
    confirmationId?: string;
  }): Promise<RollbackResult | ConfirmationChallenge | ConflictReport> {
    const loaded = await loadConfig(this.#workspace);
    const config = loaded.config;
    const { id, record } = await this.#requireRecord(input.checkpointId);
    const target = record.commitHash ?? record.draftCommit;
    if (!target) {
      throw new CheckpointError('checkpoint_incomplete', `${id} has no stored commit or tree to restore`);
    }
    const payload = { checkpointId: id, target };

    if (!input.confirmationId) {
      const summary =
        `discard uncommitted changes and restore ${record.files.length} file(s) from ${record.status === 'confirmed' ? `commit ${record.commitHash?.slice(0, 12)}` : `draft ${record.treeHash?.slice(0, 12)}`} ` +
        `in ${this.#workspace}${record.status === 'confirmed' ? ` (moves branch "${record.branch ?? 'HEAD'}" to that commit)` : ' (branch is not moved)'}`;
      return await this.issueConfirmation('rollback_checkpoint', payload, summary, {
        checkpointId: id,
        title: record.title,
        status: record.status,
        commitHash: record.commitHash,
        treeHash: record.treeHash,
        files: record.files,
        workspace: this.#workspace,
      }, config);
    }

    const pending = await this.#requireConfirmation(input.confirmationId, 'rollback_checkpoint', payload);
    const repo = await this.#ensureRepo();

    const entries = await g.statusEntries(this.#workspace);
    if (entries.length > 0) {
      const modified: FileChange[] = entries
        .filter((entry) => entry.code !== '??')
        .map((entry) => ({ path: entry.path, status: g.shortStatus(entry.code) }));
      const untracked = entries.filter((entry) => entry.code === '??').map((entry) => entry.path);
      return {
        status: 'conflict',
        reason: 'worktree_dirty',
        message: 'the working tree has uncommitted changes; rollback aborted so no work is lost',
        conflicts: { modified, untracked },
        resolution: [
          'commit the changes with confirm_checkpoint / git commit first',
          'or stash or discard them manually, then retry the rollback',
          'the plugin never resolves conflicts automatically',
        ],
      };
    }

    let branchMoved = false;
    if (record.status === 'confirmed') {
      const head = await g.headHash(this.#workspace);
      branchMoved = head !== target;
      await g.resetHard(this.#workspace, target);
    } else {
      // Drafts restore the tree only: the branch and its history stay untouched.
      await g.runGit(this.#workspace, [ 'read-tree', '--reset', '-u', target ]);
    }

    const context = await readContext(this.#workspace, id);
    const digest = context ? renderContextSummary(context) : record.contextSummary;
    const warnings: string[] = [];
    if (!context) warnings.push(`context sidecar for ${id} is missing; only files were restored`);
    if (record.status === 'confirmed' && !(await g.isAncestor(this.#workspace, target, repo.head ?? target))) {
      warnings.push('the restored commit is not an ancestor of the previous HEAD; history was rewritten');
    }
    await consumePendingConfirmation(this.#workspace, pending.id);

    return {
      status: 'rolled_back',
      checkpointId: id,
      checkpointTitle: record.title,
      restoredFrom: { commitHash: record.commitHash, treeHash: record.treeHash },
      branchMoved,
      filesRestored: record.files.length,
      contextPath: record.contextPath,
      contextDigest: digest,
      restoredPlan: context?.plan ?? [],
      rehydration: [
        'Files are restored. The captured agent context is attached below and stored at the contextPath.',
        'Treat this digest as the authoritative state of the task after the rollback: continue from the last captured request and the restored plan, and re-read files from disk before assuming their contents.',
      ].join(' '),
      warnings,
    };
  }

  /** Tag / text filtered, newest-first checkpoint listing. */
  async listCheckpoints(input: {
    tagsFilter?: string[];
    limit?: number;
    includeDrafts?: boolean;
    query?: string;
  }): Promise<{ entries: ListEntry[]; total: number; truncated: boolean }> {
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 200);
    const includeDrafts = input.includeDrafts !== false;
    const records = includeDrafts
      ? await listAllCheckpoints(this.#workspace)
      : await listRecords(this.#workspace, 'checkpoints');
    const filters = (input.tagsFilter ?? []).map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0);
    const query = input.query?.trim().toLowerCase();

    const filtered = records.filter((record) => {
      if (filters.length > 0) {
        const recordTags = record.tags.map((tag) => tag.toLowerCase());
        if (!filters.every((filterTag) => recordTags.includes(filterTag))) return false;
      }
      if (query && query.length > 0) {
        const haystack = `${record.title} ${record.remark} ${record.tags.join(' ')} ${record.contextSummary}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });

    const entries = filtered.slice(0, limit).map((record) => ({
      id: record.id,
      status: record.status,
      title: record.title,
      tags: record.tags,
      createdAt: record.createdAt,
      remark: truncate(record.remark, 200),
      commitHash: record.commitHash,
      branch: record.branch,
      filesChanged: record.files.length,
      contextSummary: truncate(record.contextSummary.replace(/\n/g, ' | '), 200),
    }));
    return { entries, total: filtered.length, truncated: filtered.length > entries.length };
  }

  /** Create a branch at a checkpoint (or at HEAD). */
  async createBranch(input: {
    branchName: string;
    checkpointId?: string;
  }): Promise<{ branch: string; startPoint: string; head: string | null; checkedOut: boolean }> {
    await this.#ensureRepo();
    const name = input.branchName.trim();
    if (!name) throw new CheckpointError('invalid_branch_name', 'branch_name must not be empty');
    const valid = await g.validateBranchName(this.#workspace, name);
    if (!valid) {
      throw new CheckpointError('invalid_branch_name', `"${name}" is not a valid git branch name`, {
        hint: 'use lowercase letters, digits, and dashes; no spaces, dots at the end, or leading dashes',
      });
    }
    const branches = await g.listBranches(this.#workspace);
    if (branches.includes(name)) {
      throw new CheckpointError('branch_exists', `branch "${name}" already exists`, { branches });
    }

    let startPoint: string;
    if (input.checkpointId) {
      const { record } = await this.#requireRecord(input.checkpointId);
      const target = record.commitHash ?? record.draftCommit;
      if (!target) throw new CheckpointError('checkpoint_incomplete', 'that checkpoint has no stored commit to branch from');
      startPoint = target;
    } else {
      const head = await g.headHash(this.#workspace);
      if (!head) {
        throw new CheckpointError(
          'no_commits',
          'the repository has no commits yet; confirm a checkpoint (or pass checkpoint_id) before creating a branch',
        );
      }
      startPoint = head;
    }

    await g.createBranch(this.#workspace, name, startPoint);
    return {
      branch: name,
      startPoint,
      head: await g.headHash(this.#workspace),
      checkedOut: false,
    };
  }

  /** Switch the checked-out branch. */
  async switchBranch(input: { branchName: string }): Promise<{ from: string | null; to: string; head: string | null }> {
    await this.#ensureRepo();
    const name = input.branchName.trim();
    const branches = await g.listBranches(this.#workspace);
    if (!branches.includes(name)) {
      throw new CheckpointError('branch_not_found', `branch "${name}" does not exist`, { branches });
    }
    const from = await g.currentBranch(this.#workspace);
    if (from === name) {
      return { from, to: name, head: await g.headHash(this.#workspace) };
    }
    try {
      await g.switchBranch(this.#workspace, name);
    } catch (error) {
      if (error instanceof g.GitError) {
        throw new CheckpointError('switch_failed', `git refused to switch to "${name}": ${error.stderr.trim() || error.message}`, {
          resolution: [ 'commit or stash your changes first', 'or check out a clean branch manually' ],
        });
      }
      throw error;
    }
    return { from, to: name, head: await g.headHash(this.#workspace) };
  }

  /** Repository + snapshot-store status. */
  async getStatus(): Promise<StatusResult> {
    const workspace = this.#workspace;
    const capsOut = await g.capabilities();
    const top = capsOut.available ? await g.topLevel(workspace) : null;
    const loaded = await loadConfig(workspace);
    const hints: string[] = [];

    const status: RepoStatus = {
      workspace,
      isRepo: top !== null,
      branch: null,
      head: null,
      isDirty: false,
      changedFiles: [],
      untrackedFiles: [],
      headCommit: null,
    };

    if (top !== null) {
      status.branch = await g.currentBranch(workspace);
      status.head = await g.headHash(workspace);
      const entries = await g.statusEntries(workspace);
      status.isDirty = entries.length > 0;
      status.changedFiles = entries
        .filter((entry) => entry.code !== '??')
        .map((entry) => ({ path: entry.path, status: g.shortStatus(entry.code) }));
      status.untrackedFiles = entries.filter((entry) => entry.code === '??').map((entry) => entry.path);
      const subject = await g.headSubject(workspace);
      if (status.head) status.headCommit = { hash: status.head, subject: subject ?? '' };
    } else {
      hints.push('workspace is not a git repository yet; call init_workspace to create one');
    }

    const [ drafts, confirmed ] = await Promise.all([
      listRecords(workspace, 'drafts'),
      listRecords(workspace, 'checkpoints'),
    ]);
    const all = [ ...drafts, ...confirmed ].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const last = all[0] ?? null;
    const storeExists = await exists(storeRoot(workspace));
    const confirmationsDir = storeSubdir(workspace, 'confirmations');
    let pendingConfirmations = 0;
    try {
      pendingConfirmations = (await readdir(confirmationsDir)).filter((entry) => entry.endsWith('.json')).length;
    } catch {
      pendingConfirmations = 0;
    }

    if (drafts.length >= loaded.config.max_draft_count) {
      hints.push(`draft backlog is at the retention limit (${loaded.config.max_draft_count}); the next draft will drop the oldest`);
    }
    if (status.isDirty) {
      hints.push('working tree has uncommitted changes; call create_draft_checkpoint at the next milestone');
    }
    if (!loaded.found) hints.push(`no ${CONFIG_FILENAME} in the workspace; built-in policy defaults are in effect`);

    return {
      workspace,
      repo: status,
      store: { path: storeRoot(workspace), exists: storeExists, drafts: drafts.length, confirmed: confirmed.length },
      config: loaded.config,
      configFile: { path: loaded.path, found: loaded.found, warnings: loaded.warnings },
      lastCheckpoint: last
        ? { id: last.id, title: last.title, status: last.status, createdAt: last.createdAt, commitHash: last.commitHash }
        : null,
      git: { available: capsOut.available, version: capsOut.version },
      pendingConfirmations,
      hints,
    };
  }

  /** All checkpoints, for tests and internal callers. */
  async allCheckpoints(): Promise<CheckpointRecord[]> {
    return await listAllCheckpoints(this.#workspace);
  }

  /** Read one record without abbreviation resolution. */
  async record(id: string): Promise<CheckpointRecord | null> {
    assertCheckpointId(id);
    return await readCheckpoint(this.#workspace, id);
  }
}
