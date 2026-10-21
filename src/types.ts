/**
 * Shared type contracts for dsh-plugin-agent-checkpoint.
 *
 * @module dsh-plugin-agent-checkpoint/types
 */

/** A single todo-plan entry mirrored from the DSH session. */
export interface PlanItem {
  content: string;
  status: string;
}

/** One digestible conversation message captured inside a context snapshot. */
export interface ContextMessage {
  role: 'user' | 'assistant';
  text: string;
  time?: number;
  /** True when `text` was shortened by the capture limits. */
  truncated?: boolean;
}

/** Aggregate information about the tools the agent used in the captured span. */
export interface ToolUsage {
  name: string;
  calls: number;
  errors: number;
}

/** Serialized DSH agent context bound to one checkpoint. */
export interface SessionContext {
  /** Schema version of this context payload. */
  version: 1;
  /** DSH session id, when the session log could be located. */
  sessionId: string | null;
  /** Working directory recorded in the session header. */
  cwd: string | null;
  /** Agent preset recorded in the session header. */
  agentPreset: string | null;
  /** Absolute path of the session log the context was read from. */
  sourceFile: string | null;
  /** ISO timestamp of capture. */
  capturedAt: string;
  /** Number of raw session events scanned. */
  eventCount: number;
  /** Number of messages retained after digestion. */
  messageCount: number;
  /** Latest todo plan state, empty when the session never wrote one. */
  plan: PlanItem[];
  /** Retained conversation messages, oldest first. */
  messages: ContextMessage[];
  /** Per-tool call/error counters. */
  toolUsage: ToolUsage[];
  /** True when any limit dropped or shortened content. */
  truncated: boolean;
  /** Serialized payload size in bytes. */
  bytes: number;
  /** Non-fatal capture problems (missing session log, undecodable events, ...). */
  warnings: string[];
}

/** File-level change recorded between the base commit and the draft tree. */
export interface FileChange {
  /** Repo-relative path. */
  path: string;
  /** Single-letter git status code (A/M/D/R/T). */
  status: string;
}

export type CheckpointStatus = 'draft' | 'confirmed';

/** Persisted checkpoint record; one JSON file per checkpoint. */
export interface CheckpointRecord {
  /** Stable id: `draft-<epoch-ms>-<rand>` or `ckpt-<epoch-ms>-<rand>`. */
  id: string;
  status: CheckpointStatus;
  title: string;
  tags: string[];
  remark: string;
  /** ISO timestamp of draft creation. */
  createdAt: string;
  /** ISO timestamp of the last state transition. */
  updatedAt: string;
  /** Absolute workspace path this checkpoint belongs to. */
  workspace: string;
  /** Branch checked out when the draft was taken. */
  branch: string | null;
  /** Commit that was HEAD when the draft was taken (`null` for an empty repo). */
  baseCommit: string | null;
  /** Tree object hash of the captured working-tree state (drafts only). */
  treeHash: string | null;
  /** Dangling/anchor commit object holding `treeHash` (drafts only). */
  draftCommit: string | null;
  /** Confirmed commit hash (`null` while still a draft). */
  commitHash: string | null;
  /** Parent commit of `commitHash` (`null` for the first commit). */
  parentCommit: string | null;
  /** Files changed by this checkpoint. */
  files: FileChange[];
  /** `git diff --stat` output, truncated for storage. */
  diffStat: string;
  /** Unified diff body, truncated for storage. */
  diff: string;
  /** True when `diff` was cut short by the storage limit. */
  diffTruncated: boolean;
  /** Path of the full diff patch on disk, when the body exceeded the inline cap. */
  diffPath: string | null;
  /** Path of the serialized agent context on disk. */
  contextPath: string;
  /** Compact, human-readable context digest. */
  contextSummary: string;
  /** Session id the context came from. */
  sessionId: string | null;
  /** Git ref that anchors the checkpoint objects so `gc` cannot prune them. */
  anchorRef: string;
}

/** A pending two-phase confirmation token for a destructive operation. */
export interface PendingConfirmation {
  id: string;
  action: 'confirm_checkpoint' | 'rollback_checkpoint';
  /** Hash of the normalized request arguments, to detect a swapped payload. */
  payloadHash: string;
  createdAt: string;
  expiresAt: string;
  /** Short human-facing summary of exactly what approval will do. */
  summary: string;
  /** Structured details shown to the operator before approval. */
  details: Record<string, unknown>;
}

/** Resolved plugin configuration (file values merged over defaults). */
export interface CheckpointConfig {
  auto_draft_on_milestone: boolean;
  ignore_patterns: string[];
  max_draft_count: number;
  /** Maximum characters kept per captured message. */
  max_context_message_chars: number;
  /** Maximum number of conversation messages retained. */
  max_context_messages: number;
  /** Hard cap on the serialized context payload size. */
  max_context_bytes: number;
  /** Maximum characters of diff kept inline in the checkpoint JSON. */
  max_diff_chars: number;
  /** Lifetime of a two-phase confirmation token, in seconds. */
  confirmation_ttl_seconds: number;
}

/** Repository facts surfaced by `get_status` / `init_workspace`. */
export interface RepoStatus {
  workspace: string;
  isRepo: boolean;
  branch: string | null;
  head: string | null;
  isDirty: boolean;
  changedFiles: FileChange[];
  untrackedFiles: string[];
  headCommit: { hash: string; subject: string } | null;
}
