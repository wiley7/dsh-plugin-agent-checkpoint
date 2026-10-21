/**
 * DSH session-log reader and context digest builder.
 *
 * A checkpoint binds two things together: the working-tree state (handled by
 * {@link module:dsh-plugin-agent-checkpoint/git}) and the agent context that
 * produced it. The latter lives in DSH's own append-only session log:
 *
 *   $DSH_HOME/sessions/<bucket>/session-<uuid>/session.v4.jsonl.zstd
 *
 * `session.v4` is a zstd-compressed JSONL stream whose first record is a
 * `{"type":"session", ...}` header carrying `id`, `cwd` and `agentPreset`.
 *
 * The format is an implementation detail of DSH and may change; that is exactly
 * the maintenance surface this plugin exists to own (see README "Risks"). Every
 * read is therefore defensive: unknown record shapes are counted and skipped,
 * and a missing/undecodable log degrades to an empty context with warnings
 * instead of failing the checkpoint.
 *
 * @module dsh-plugin-agent-checkpoint/session
 */

import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createZstdDecompress, constants as zlibConstants } from 'node:zlib';

import type { ContextMessage, PlanItem, SessionContext, ToolUsage } from './types.js';

/** Maximum bytes of decompressed session text consumed for one capture. */
const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024;

/** Largest number of candidate session directories probed during discovery. */
const MAX_DISCOVERY_CANDIDATES = 12;

/** Filename pattern for DSH session logs, across schema versions. */
const SESSION_FILE_RE = /^session\.v(\d+)\.jsonl(\.zstd)?$/;

export interface SessionFileCandidate {
  file: string;
  /** Session id taken from the directory name when available. */
  sessionIdFromDir: string | null;
  version: number;
  compressed: boolean;
  mtimeMs: number;
}

export interface SessionHeader {
  id: string | null;
  cwd: string | null;
  agentPreset: string | null;
  version: number | null;
}

export interface DiscoverOptions {
  /** Workspace whose session log should be found. */
  workspacePath: string;
  /** Explicit session id (usually `$DSH_SESSION_ID`); wins when it matches a dir. */
  sessionId?: string | null;
  /** Explicit session log path; bypasses discovery entirely. */
  sessionFile?: string | null;
  /** Override `$DSH_HOME`. */
  dshHome?: string | null;
  /** Maximum candidates probed. */
  maxCandidates?: number;
}

export interface DiscoveryResult {
  /** Chosen log, or null when nothing matched. */
  file: string | null;
  sessionId: string | null;
  /** All candidates considered, newest first. */
  candidates: SessionFileCandidate[];
  /** Why discovery fell back, surfaced to the operator. */
  warning: string | null;
}

/** Resolve the DSH home directory. */
export function resolveDshHome(explicit?: string | null): string {
  const value = explicit ?? process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh');
  return path.resolve(value);
}

/** Resolve the sessions root directory. */
export function sessionsRoot(dshHome?: string | null): string {
  return path.join(resolveDshHome(dshHome), 'sessions');
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    const info = await stat(target);
    return info.isDirectory();
  } catch {
    return false;
  }
}

function parseVersion(file: string): { version: number; compressed: boolean } | null {
  const match = SESSION_FILE_RE.exec(path.basename(file));
  if (!match) return null;
  return { version: Number(match[1]), compressed: match[2] === '.zstd' };
}

/**
 * Enumerate session logs under the DSH sessions root, newest first.
 *
 * Bucket directory names are derived from the session cwd with lossy escaping
 * (non-ASCII path segments become `~XXXX~`), so they are never trusted for
 * matching: only the directory name of the session itself is used, and the
 * header `cwd` is verified after decompression.
 */
export async function listSessionFiles(dshHome?: string | null): Promise<SessionFileCandidate[]> {
  const root = sessionsRoot(dshHome);
  let buckets: string[];
  try {
    buckets = await readdir(root);
  } catch {
    return [];
  }
  const found: SessionFileCandidate[] = [];
  for (const bucket of buckets) {
    const bucketPath = path.join(root, bucket);
    if (!(await isDirectory(bucketPath))) continue;
    let sessionDirs: string[];
    try {
      sessionDirs = await readdir(bucketPath);
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      const sessionPath = path.join(bucketPath, sessionDir);
      if (!(await isDirectory(sessionPath))) continue;
      let files: string[];
      try {
        files = await readdir(sessionPath);
      } catch {
        continue;
      }
      // Prefer the newest schema version available in each session directory.
      const parsed = files
        .map((name) => ({ name, info: parseVersion(name) }))
        .filter((entry): entry is { name: string; info: { version: number; compressed: boolean } } => entry.info !== null)
        .sort((a, b) => b.info.version - a.info.version || (b.info.compressed ? 1 : 0) - (a.info.compressed ? 1 : 0));
      const best = parsed[0];
      if (!best) continue;
      const file = path.join(sessionPath, best.name);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) continue;
      const dirSessionId = /^session-(.+)$/.exec(sessionDir)?.[1] ?? null;
      found.push({
        file,
        sessionIdFromDir: dirSessionId,
        version: best.info.version,
        compressed: best.info.compressed,
        mtimeMs: info.mtimeMs,
      });
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found;
}

/** Read at most `maxBytes` of decompressed text from a (possibly zstd) log. */
async function readDecompressed(
  file: string,
  compressed: boolean,
  options: { maxBytes?: number; firstLineOnly?: boolean } = {},
): Promise<{ text: string; truncated: boolean }> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_READ_BYTES;
  const sink = { text: '', truncated: false };

  const accept = (chunk: string): boolean => {
    // Returns true when enough data has been gathered.
    sink.text += chunk;
    if (options.firstLineOnly && sink.text.includes('\n')) {
      const newline = sink.text.indexOf('\n');
      sink.text = sink.text.slice(0, newline);
      return true;
    }
    if (sink.text.length >= maxBytes) {
      sink.text = sink.text.slice(0, maxBytes);
      sink.truncated = true;
      return true;
    }
    return false;
  };

  if (!compressed) {
    const stream = createReadStream(file, { encoding: 'utf8' });
    return await new Promise((resolve, reject) => {
      stream.on('data', (chunk: string | Buffer) => {
        if (accept(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))) {
          stream.destroy();
          resolve({ text: sink.text, truncated: sink.truncated });
        }
      });
      stream.on('end', () => resolve({ text: sink.text, truncated: sink.truncated }));
      stream.on('error', reject);
    });
  }

  // Preferred path: node's built-in zstd stream (Node >= 23.8). Falls back to
  // the system `zstd` binary for older runtimes, matching the requirement that
  // the plugin must not add heavyweight native dependencies.
  if (typeof createZstdDecompress === 'function') {
    try {
      const decompressor = createZstdDecompress({
        chunkSize: 256 * 1024,
        params: { [zlibConstants.ZSTD_d_windowLogMax]: 27 },
      });
      const source = createReadStream(file);
      source.pipe(decompressor);
      return await new Promise((resolve, reject) => {
        decompressor.setEncoding('utf8');
        decompressor.on('data', (chunk: string) => {
          if (accept(chunk)) {
            source.destroy();
            decompressor.destroy();
            resolve({ text: sink.text, truncated: sink.truncated });
          }
        });
        decompressor.on('end', () => resolve({ text: sink.text, truncated: sink.truncated }));
        decompressor.on('error', reject);
        source.on('error', reject);
      });
    } catch {
      // fall through to CLI
    }
  }

  return await new Promise((resolve, reject) => {
    const child = spawn('zstd', [ '-dc', '--quiet', file ], { stdio: [ 'ignore', 'pipe', 'pipe' ] });
    child.stdout.setEncoding('utf8');
    let settled = false;
    const finish = (result: { text: string; truncated: boolean }): void => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve(result);
    };
    child.stdout.on('data', (chunk: string) => {
      if (accept(chunk)) finish({ text: sink.text, truncated: sink.truncated });
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(new Error(`cannot decompress session log (no zstd support): ${error.message}`));
    });
    child.on('close', () => finish({ text: sink.text, truncated: sink.truncated }));
  });
}

/** Parse the session header record. */
export async function readSessionHeader(file: string): Promise<SessionHeader | null> {
  const parsed = parseVersion(file);
  if (!parsed) return null;
  const { text } = await readDecompressed(file, parsed.compressed, { firstLineOnly: true, maxBytes: 256 * 1024 });
  const line = text.split('\n').find((entry) => entry.trim().length > 0);
  if (!line) return null;
  try {
    const record = JSON.parse(line) as Record<string, unknown>;
    if (record.type !== 'session') return null;
    return {
      id: typeof record.id === 'string' ? record.id : null,
      cwd: typeof record.cwd === 'string' ? record.cwd : null,
      agentPreset: typeof record.agentPreset === 'string' ? record.agentPreset : null,
      version: typeof record.version === 'number' ? record.version : null,
    };
  } catch {
    return null;
  }
}

function normalizePath(value: string): string {
  return path.resolve(value).replace(/\/+$/, '');
}

/**
 * Locate the session log that belongs to `workspacePath`.
 *
 * Order of preference:
 * 1. an explicit `sessionFile`;
 * 2. a directory whose name equals the explicit session id (usually
 *    `$DSH_SESSION_ID`), verified by the header `cwd`;
 * 3. the most recently modified log whose header `cwd` equals the workspace.
 *
 * Because each candidate needs decompression to inspect its header, only the
 * newest `maxCandidates` logs are probed.
 */
export async function discoverSessionLog(options: DiscoverOptions): Promise<DiscoveryResult> {
  const workspace = normalizePath(options.workspacePath);
  const warnings: string[] = [];
  const candidates = await listSessionFiles(options.dshHome);
  const probeLimit = options.maxCandidates ?? MAX_DISCOVERY_CANDIDATES;

  if (options.sessionFile) {
    const parsed = parseVersion(options.sessionFile);
    if (parsed) {
      const header = await readSessionHeader(options.sessionFile).catch(() => null);
      if (header?.cwd && normalizePath(header.cwd) !== workspace) {
        warnings.push(
          `explicit session file ${path.basename(path.dirname(options.sessionFile))} belongs to ${header.cwd}, not ${workspace}`,
        );
      }
      return {
        file: options.sessionFile,
        sessionId: header?.id ?? null,
        candidates,
        warning: warnings.length > 0 ? warnings.join('; ') : null,
      };
    }
    return { file: null, sessionId: null, candidates, warning: `not a DSH session log: ${options.sessionFile}` };
  }

  if (candidates.length === 0) {
    return {
      file: null,
      sessionId: null,
      candidates,
      warning: `no DSH session logs found under ${sessionsRoot(options.dshHome)}`,
    };
  }

  const byId = options.sessionId
    ? candidates.filter((candidate) => candidate.sessionIdFromDir === options.sessionId)
    : [];

  const probeOrder = [ ...byId, ...candidates.filter((candidate) => !byId.includes(candidate)) ].slice(0, probeLimit);
  for (const candidate of probeOrder) {
    const header = await readSessionHeader(candidate.file).catch(() => null);
    if (!header) {
      warnings.push(`unreadable session log: ${candidate.file}`);
      continue;
    }
    if (byId.includes(candidate) && options.sessionId) {
      return { file: candidate.file, sessionId: header.id ?? options.sessionId, candidates, warning: null };
    }
    if (header.cwd && normalizePath(header.cwd) === workspace) {
      return { file: candidate.file, sessionId: header.id ?? candidate.sessionIdFromDir, candidates, warning: null };
    }
  }

  return {
    file: null,
    sessionId: null,
    candidates,
    warning:
      warnings.length > 0
        ? warnings.join('; ')
        : `no session log for ${workspace} among the ${probeOrder.length} most recent logs`,
  };
}

/** Bounds applied while digesting a session. */
export interface CaptureLimits {
  maxMessageChars: number;
  maxMessages: number;
  maxBytes: number;
  maxReadBytes?: number;
}

interface RawEvent {
  type?: unknown;
  time?: unknown;
  data?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Strip base64-ish payloads and long runs the agent never needs restored. */
export function scrubText(value: string, maxChars: number): { text: string; truncated: boolean } {
  let text = value
    // inline data URIs / base64 blobs
    .replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{32,}/gi, '[skipped: base64 payload]')
    .replace(/(?:[A-Za-z0-9+/]{120,}={0,2})/g, '[skipped: base64/local]')
    // collapse runs of blank lines
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  let truncated = false;
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars)}…`;
    truncated = true;
  }
  return { text, truncated };
}

/** Concatenate text blocks of a DSH content array. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/** Record kinds injected by the harness that carry no user intent. */
const SYNTHETIC_USER_KINDS = new Set([ 'runtime-context', 'time-context', 'model-selection', 'system-reminder' ]);

interface DigestState {
  messages: ContextMessage[];
  plan: PlanItem[];
  toolUsage: Map<string, ToolUsage>;
  eventCount: number;
  skipped: number;
  truncated: boolean;
}

function pushMessage(state: DigestState, message: ContextMessage, limits: CaptureLimits): void {
  state.messages.push(message);
  while (state.messages.length > limits.maxMessages) {
    state.messages.shift();
    state.truncated = true;
  }
}

function parseTodos(value: unknown): PlanItem[] | null {
  const list = isRecord(value) && Array.isArray(value.todos) ? value.todos : Array.isArray(value) ? value : null;
  if (!list) return null;
  const plan: PlanItem[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const content = typeof item.content === 'string' ? item.content : null;
    if (!content) continue;
    plan.push({ content, status: typeof item.status === 'string' ? item.status : 'pending' });
  }
  return plan.length > 0 ? plan : null;
}

/**
 * Reduce a DSH session event stream to a bounded, reconstructible digest.
 *
 * Deliberately skipped: `data.stream` (token stream, megabytes), tool-result
 * bodies beyond a short prefix, images/base64, and harness-injected synthetic
 * user messages.
 */
export function digestEvents(lines: string[], limits: CaptureLimits): Omit<SessionContext, 'version' | 'sessionId' | 'cwd' | 'agentPreset' | 'sourceFile' | 'capturedAt' | 'bytes'> {
  const state: DigestState = {
    messages: [],
    plan: [],
    toolUsage: new Map(),
    eventCount: 0,
    skipped: 0,
    truncated: false,
  };

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    let event: RawEvent;
    try {
      event = JSON.parse(line) as RawEvent;
    } catch {
      state.skipped += 1;
      continue;
    }
    if (!isRecord(event)) {
      state.skipped += 1;
      continue;
    }
    state.eventCount += 1;
    const type = typeof event.type === 'string' ? event.type : '';
    const data = isRecord(event.data) ? event.data : null;
    if (!data) continue;

    switch (type) {
      case 'user/message': {
        const source = isRecord(data.source) ? data.source : null;
        const kind = source && typeof source.kind === 'string' ? source.kind : 'user';
        if (SYNTHETIC_USER_KINDS.has(kind)) break;
        const raw = contentText(data.content);
        if (raw.trim().length === 0) break;
        if (raw.trimStart().startsWith('<system-reminder>')) break;
        const scrubbed = scrubText(raw, limits.maxMessageChars);
        pushMessage(
          state,
          {
            role: 'user',
            text: scrubbed.text,
            time: typeof event.time === 'number' ? event.time : undefined,
            ...(scrubbed.truncated ? { truncated: true } : {}),
          },
          limits,
        );
        if (scrubbed.truncated) state.truncated = true;
        break;
      }
      case 'assistant/message': {
        const message = isRecord(data.message) ? data.message : null;
        const raw = message ? contentText(message.content) : '';
        if (raw.trim().length === 0) break;
        const scrubbed = scrubText(raw, limits.maxMessageChars);
        pushMessage(
          state,
          {
            role: 'assistant',
            text: scrubbed.text,
            time: typeof event.time === 'number' ? event.time : undefined,
            ...(scrubbed.truncated ? { truncated: true } : {}),
          },
          limits,
        );
        if (scrubbed.truncated) state.truncated = true;
        break;
      }
      case 'tool/call': {
        const name = typeof data.name === 'string' ? data.name : 'unknown';
        const entry = state.toolUsage.get(name) ?? { name, calls: 0, errors: 0 };
        entry.calls += 1;
        state.toolUsage.set(name, entry);
        break;
      }
      case 'tool/result': {
        const message = isRecord(data.message) ? data.message : null;
        const text = message ? contentText(message.content) : '';
        const isError = data.isError === true || /^(error|mcp error|tool error)\b/i.test(text.trimStart());
        const callName =
          typeof data.name === 'string'
            ? data.name
            : typeof data.toolName === 'string'
              ? data.toolName
              : null;
        if (callName) {
          const entry = state.toolUsage.get(callName) ?? { name: callName, calls: 0, errors: 0 };
          if (isError) entry.errors += 1;
          state.toolUsage.set(callName, entry);
        } else if (isError) {
          const entry = state.toolUsage.get('unknown') ?? { name: 'unknown', calls: 0, errors: 0 };
          entry.errors += 1;
          state.toolUsage.set('unknown', entry);
        }
        break;
      }
      case 'todo/write': {
        const plan = parseTodos(data);
        if (plan) state.plan = plan;
        break;
      }
      default:
        break;
    }
  }

  const plan = state.plan;
  const toolUsage = [ ...state.toolUsage.values() ].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

  return {
    eventCount: state.eventCount,
    messageCount: state.messages.length,
    plan,
    messages: state.messages,
    toolUsage,
    truncated: state.truncated,
    warnings: state.skipped > 0 ? [ `${state.skipped} session record(s) could not be parsed and were skipped` ] : [],
  };
}

/** Render the compact digest embedded in every checkpoint preview. */
export function renderContextSummary(context: Pick<SessionContext, 'plan' | 'messages' | 'toolUsage' | 'sessionId'>): string {
  const lines: string[] = [];
  const done = context.plan.filter((item) => item.status === 'completed').length;
  if (context.plan.length > 0) {
    lines.push(`Plan: ${done}/${context.plan.length} completed`);
    for (const item of context.plan.slice(0, 8)) {
      const marker = item.status === 'completed' ? 'x' : item.status === 'in_progress' ? '>' : ' ';
      lines.push(`  [${marker}] ${item.content.length > 100 ? `${item.content.slice(0, 100)}…` : item.content}`);
    }
    if (context.plan.length > 8) lines.push(`  … ${context.plan.length - 8} more`);
  } else {
    lines.push('Plan: (none recorded)');
  }
  if (context.messages.length > 0) {
    const lastUser = [ ...context.messages ].reverse().find((message) => message.role === 'user');
    if (lastUser) {
      const text = lastUser.text.replace(/\s+/g, ' ').trim();
      lines.push(`Last user request: ${text.length > 160 ? `${text.slice(0, 160)}…` : text}`);
    }
    lines.push(`Messages captured: ${context.messages.length}`);
  }
  if (context.toolUsage.length > 0) {
    const top = context.toolUsage.slice(0, 6).map((entry) => `${entry.name}×${entry.calls}${entry.errors > 0 ? ` (${entry.errors} err)` : ''}`);
    lines.push(`Tools: ${top.join(', ')}`);
  }
  return lines.join('\n');
}

export interface CaptureOptions extends DiscoverOptions {
  /** Explicit log path (test hook); overrides discovery. */
  sessionFile?: string | null;
  limits: CaptureLimits;
}

export interface CaptureResult {
  context: SessionContext;
  /** Non-fatal problems (no log found, truncated read, ...). */
  warnings: string[];
}

/**
 * Capture the current agent context for `workspacePath`.
 *
 * Never throws for environmental problems: a missing session log yields a
 * valid-but-empty context plus warnings, so file checkpoints stay usable.
 */
export async function captureSessionContext(options: CaptureOptions): Promise<CaptureResult> {
  const warnings: string[] = [];
  const capturedAt = new Date().toISOString();
  const empty = (): SessionContext => {
    const context: SessionContext = {
      version: 1,
      sessionId: null,
      cwd: normalizePath(options.workspacePath),
      agentPreset: null,
      sourceFile: null,
      capturedAt,
      eventCount: 0,
      messageCount: 0,
      plan: [],
      messages: [],
      toolUsage: [],
      truncated: false,
      bytes: 0,
      warnings: [ ...warnings ],
    };
    context.bytes = Buffer.byteLength(JSON.stringify(context), 'utf8');
    return context;
  };

  const discovery = await discoverSessionLog(options);
  if (!discovery.file) {
    if (discovery.warning) warnings.push(discovery.warning);
    return { context: empty(), warnings };
  }

  const parsed = parseVersion(discovery.file);
  if (!parsed) {
    warnings.push(`unsupported session log name: ${path.basename(discovery.file)}`);
    return { context: empty(), warnings };
  }

  let text: string;
  let readTruncated = false;
  try {
    const read = await readDecompressed(discovery.file, parsed.compressed, {
      maxBytes: options.limits.maxReadBytes ?? DEFAULT_MAX_READ_BYTES,
    });
    text = read.text;
    readTruncated = read.truncated;
  } catch (error) {
    warnings.push(`could not read session log: ${(error as Error).message}`);
    return { context: empty(), warnings };
  }

  let lines = text.split('\n');
  if (readTruncated && lines.length > 0) {
    // The first line is almost certainly partial when the read started at the
    // head of a byte cap and got cut; drop it only when the cap was applied.
    lines = lines.slice(1);
    warnings.push(
      `session log exceeded the read cap (${options.limits.maxReadBytes ?? DEFAULT_MAX_READ_BYTES} bytes); only the newest part was captured`,
    );
  }

  let header: SessionHeader | null = null;
  const headerLine = lines.find((line) => line.trim().length > 0);
  if (headerLine) {
    try {
      const record = JSON.parse(headerLine) as Record<string, unknown>;
      if (record.type === 'session') {
        header = {
          id: typeof record.id === 'string' ? record.id : null,
          cwd: typeof record.cwd === 'string' ? record.cwd : null,
          agentPreset: typeof record.agentPreset === 'string' ? record.agentPreset : null,
          version: typeof record.version === 'number' ? record.version : null,
        };
      }
    } catch {
      // header parse failure is already covered by the digest warnings
    }
  }

  const digest = digestEvents(lines, options.limits);
  const context: SessionContext = {
    version: 1,
    sessionId: header?.id ?? discovery.sessionId ?? null,
    cwd: header?.cwd ?? normalizePath(options.workspacePath),
    agentPreset: header?.agentPreset ?? null,
    sourceFile: discovery.file,
    capturedAt,
    eventCount: digest.eventCount,
    messageCount: digest.messageCount,
    plan: digest.plan,
    messages: digest.messages,
    toolUsage: digest.toolUsage,
    truncated: digest.truncated || readTruncated,
    bytes: 0,
    warnings: [ ...warnings, ...digest.warnings ],
  };
  if (header?.version !== null && header?.version !== undefined && header.version > 0) {
    // Recorded for diagnostics only; the digest stays schema-agnostic.
    context.agentPreset = context.agentPreset ?? `v${header.version}`;
  }

  // Enforce the hard byte cap by dropping the oldest messages.
  let bytes = Buffer.byteLength(JSON.stringify(context), 'utf8');
  while (bytes > options.limits.maxBytes && context.messages.length > 1) {
    context.messages.shift();
    context.messageCount = context.messages.length;
    context.truncated = true;
    bytes = Buffer.byteLength(JSON.stringify(context), 'utf8');
  }
  if (bytes > options.limits.maxBytes) {
    context.plan = context.plan.slice(0, 10);
    context.toolUsage = context.toolUsage.slice(0, 20);
    context.truncated = true;
    bytes = Buffer.byteLength(JSON.stringify(context), 'utf8');
    if (bytes > options.limits.maxBytes) {
      context.messages = [];
      context.messageCount = 0;
      warnings.push('context payload exceeded max_context_bytes; conversation messages were dropped');
      context.warnings = [ ...new Set([ ...context.warnings, ...warnings ]) ];
      context.truncated = true;
      bytes = Buffer.byteLength(JSON.stringify(context), 'utf8');
    }
  }
  context.bytes = bytes;
  context.warnings = [ ...new Set(context.warnings) ];
  warnings.push(...context.warnings.filter((warning) => !warnings.includes(warning)));
  return { context, warnings };
}
