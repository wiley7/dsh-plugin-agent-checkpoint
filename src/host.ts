/**
 * Host half of the plugin — the loopback HTTP endpoint behind the browser badge.
 *
 * The Web GUI cannot run git, so the "current commit" hint under each reply is
 * served by this route: `/api/agent-checkpoint/git` answers with the workspace's
 * branch, HEAD commit and a bounded commit timeline (newest first), annotated
 * with the confirmed checkpoints that point at each commit.
 *
 * The route is read-only, same-origin (the client bundle fetches it directly)
 * and refuses non-loopback peers. It never writes to the repository and never
 * commits: the destructive paths stay behind the MCP confirmation handshake.
 *
 * @module dsh-plugin-agent-checkpoint/host
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { realpath } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { CheckpointError, CheckpointService } from './checkpoint.js';
import { currentBranch, git, headHash, isDirty, isInsideWorkTree } from './git.js';
import { discoverSessionLog, readSessionHeader, resolveDshHome } from './session.js';
import { listRecords } from './store.js';
import type { CheckpointRecord } from './types.js';

/** Cordis plugin name; must match the package name used by the bundle patch. */
export const name = 'agent-checkpoint';
/** The host service this plugin contributes a route to. */
export const inject = [ 'webServer' ];
/** Exact route the browser half polls. */
export const ROUTE_PATH = '/api/agent-checkpoint/git';
/** Exact route that initialises a project so the badge has something to show. */
export const INIT_ROUTE_PATH = '/api/agent-checkpoint/init';
/** Commits returned when the caller does not ask for a specific window. */
export const DEFAULT_MAX_COMMITS = 120;
/** Upper bound for `?limit=`, so one request cannot read a whole monorepo history. */
export const MAX_COMMITS_LIMIT = 500;

/** User-facing configuration of the host half (the bundle patch passes nothing). */
export interface AgentCheckpointHostConfig {
  /** Workspace to report on when neither the query nor the session log names one. */
  workspace?: string;
  /** Default timeline length. */
  maxCommits?: number;
}

/** Where the reported workspace came from, surfaced for debugging. */
export type WorkspaceSource = 'query' | 'session' | 'config' | 'env' | 'cwd';

/** One confirmed checkpoint pointing at a commit. */
export interface CheckpointRef {
  id: string;
  title: string;
  tags: string[];
}

/** One entry of the commit timeline. */
export interface CommitEntry {
  hash: string;
  short: string;
  subject: string;
  committedAt: string;
  /** Epoch milliseconds, so the browser can compare against turn timestamps. */
  committedAtMs: number;
  /** Confirmed checkpoint created from this commit, when one exists. */
  checkpoint: CheckpointRef | null;
}

/** The JSON body of {@link ROUTE_PATH}. */
export interface GitSnapshot {
  ok: boolean;
  /** Absolute workspace path the reading came from. */
  workspace: string;
  source: WorkspaceSource;
  sessionId: string | null;
  isRepo: boolean;
  branch: string | null;
  head: CommitEntry | null;
  isDirty: boolean;
  /** Commits newest first; empty when the repository has no commit yet. */
  commits: CommitEntry[];
  capturedAt: string;
  /** Stable error code (`not_a_git_repo`, `invalid_workspace`, …) or null. */
  error: string | null;
  warnings: string[];
}

/** Minimal shape of the `webServer` service this plugin needs. */
export interface WebServerLike {
  register(route: {
    kind: 'exact' | 'prefix';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
  }): () => void;
}

/** Minimal shape of the Cordis context this plugin needs. */
export interface PluginContextLike {
  webServer: WebServerLike;
  effect?: (run: () => (() => void) | void, label?: string) => unknown;
}

/** Inputs that decide which workspace gets reported. */
export interface ResolveWorkspaceInput {
  /** `?workspace=` — must be absolute. */
  workspace?: string | null;
  /** `?session=` — resolved through the DSH session logs. */
  sessionId?: string | null;
  /** Plugin configuration. */
  config?: AgentCheckpointHostConfig;
  /** Environment override, defaulting to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Last resort, defaulting to `process.cwd()`. */
  cwd?: string;
}

/** Result of {@link resolveWorkspace}. */
export interface WorkspaceResolution {
  workspace: string;
  source: WorkspaceSource;
  sessionId: string | null;
  warnings: string[];
}

/** True for addresses the loopback interface can produce. */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  if (!address) return false;
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return normalized === '127.0.0.1' || normalized === '::1' || normalized.startsWith('127.');
}

/** Normalise a configured path, or null when it is not an absolute path. */
async function canonicalDirectory(target: string): Promise<string | null> {
  const absolute = isAbsolute(target) ? target : null;
  if (absolute === null) return null;
  try {
    return await realpath(absolute);
  } catch {
    return resolvePath(absolute);
  }
}

/** Clamp a candidate timeline length into the accepted window. */
export function parseMaxCommits(value: unknown, fallback: number = DEFAULT_MAX_COMMITS): number {
  const numeric = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) return fallback;
  const rounded = Math.trunc(numeric);
  if (rounded < 1) return fallback;
  return Math.min(rounded, MAX_COMMITS_LIMIT);
}

/** Tolerate a missing or partial config object without throwing at activation. */
export function normalizeHostConfig(raw: unknown): AgentCheckpointHostConfig {
  if (typeof raw !== 'object' || raw === null) return {};
  const record = raw as Record<string, unknown>;
  const config: AgentCheckpointHostConfig = {};
  if (typeof record.workspace === 'string' && record.workspace.trim() !== '') config.workspace = record.workspace;
  if (record.maxCommits !== undefined) config.maxCommits = parseMaxCommits(record.maxCommits);
  return config;
}

/**
 * Decide which workspace to report, in the order the browser expects:
 * explicit query, then the session log's `cwd`, then the configured workspace,
 * then `$DSH_WORKSPACE`, then the process directory.
 */
export async function resolveWorkspace(input: ResolveWorkspaceInput = {}): Promise<WorkspaceResolution> {
  const warnings: string[] = [];
  const env = input.env ?? process.env;

  if (input.workspace) {
    const canonical = await canonicalDirectory(input.workspace);
    if (canonical !== null) return { workspace: canonical, source: 'query', sessionId: input.sessionId ?? null, warnings };
    warnings.push(`ignoring non-absolute workspace query: ${input.workspace}`);
  }

  const sessionId = input.sessionId ?? null;
  if (sessionId) {
    const discovery = await discoverSessionLog({
      workspacePath: '',
      sessionId,
      dshHome: resolveDshHome(env.DSH_HOME),
    }).catch(() => null);
    if (discovery?.warning) warnings.push(discovery.warning);
    const header = discovery?.file ? await readSessionHeader(discovery.file).catch(() => null) : null;
    const fromSession = header?.cwd ?? null;
    if (fromSession !== null) {
      const canonical = await canonicalDirectory(fromSession);
      if (canonical !== null) return { workspace: canonical, source: 'session', sessionId, warnings };
      warnings.push(`session ${sessionId} reports a non-absolute cwd: ${fromSession}`);
    } else if (discovery?.file) {
      warnings.push(`session log ${discovery.file} has no cwd header`);
    }
  }

  if (input.config?.workspace) {
    const canonical = await canonicalDirectory(input.config.workspace);
    if (canonical !== null) return { workspace: canonical, source: 'config', sessionId, warnings };
    warnings.push(`ignoring non-absolute configured workspace: ${input.config.workspace}`);
  }

  const fromEnv = env.DSH_WORKSPACE;
  if (fromEnv && fromEnv.trim() !== '') {
    const canonical = await canonicalDirectory(fromEnv);
    if (canonical !== null) return { workspace: canonical, source: 'env', sessionId, warnings };
    warnings.push(`ignoring non-absolute $DSH_WORKSPACE: ${fromEnv}`);
  }

  const cwd = input.cwd ?? process.cwd();
  const canonical = (await canonicalDirectory(cwd)) ?? resolvePath(cwd);
  return { workspace: canonical, source: 'cwd', sessionId, warnings };
}

/** Index confirmed checkpoints by the commit they were created from. */
export async function checkpointIndex(workspacePath: string): Promise<Map<string, CheckpointRef>> {
  const index = new Map<string, CheckpointRef>();
  const records: CheckpointRecord[] = await listRecords(workspacePath, 'checkpoints').catch(() => []);
  for (const record of records) {
    if (!record.commitHash) continue;
    index.set(record.commitHash, {
      id: record.id,
      title: record.title,
      tags: Array.isArray(record.tags) ? record.tags : [],
    });
  }
  return index;
}

/** Read the newest `maxCommits` commits, oldest failure (empty repo) tolerated. */
export async function readCommitTimeline(
  workspacePath: string,
  maxCommits: number,
  index: Map<string, CheckpointRef> = new Map(),
): Promise<CommitEntry[]> {
  const format = '--format=%H%x1f%ct%x1f%cI%x1f%s';
  const raw = await git(workspacePath, [ 'log', `--max-count=${maxCommits}`, format ]).catch(() => null);
  if (raw === null) return [];
  const entries: CommitEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const [ hash, committedSeconds, committedIso, ...subjectParts ] = line.split('\x1f');
    if (!hash) continue;
    const seconds = Number.parseInt(committedSeconds ?? '', 10);
    const committedAtMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(committedIso ?? '');
    entries.push({
      hash,
      short: hash.slice(0, 7),
      subject: subjectParts.join('\x1f').trim(),
      committedAt: committedIso ?? (Number.isFinite(committedAtMs) ? new Date(committedAtMs).toISOString() : ''),
      committedAtMs: Number.isFinite(committedAtMs) ? committedAtMs : 0,
      checkpoint: index.get(hash) ?? null,
    });
  }
  return entries;
}

/** Build the payload of one {@link ROUTE_PATH} response. */
export async function buildGitSnapshot(
  workspacePath: string,
  options: { maxCommits?: number; source?: WorkspaceSource; sessionId?: string | null; warnings?: string[] } = {},
): Promise<GitSnapshot> {
  const source = options.source ?? 'cwd';
  const sessionId = options.sessionId ?? null;
  const warnings = [ ...(options.warnings ?? []) ];
  const maxCommits = parseMaxCommits(options.maxCommits);
  const capturedAt = new Date().toISOString();

  let isRepo = false;
  try {
    isRepo = await isInsideWorkTree(workspacePath);
  } catch {
    isRepo = false;
  }
  if (!isRepo) {
    return {
      ok: false,
      workspace: workspacePath,
      source,
      sessionId,
      isRepo: false,
      branch: null,
      head: null,
      isDirty: false,
      commits: [],
      capturedAt,
      error: 'not_a_git_repo',
      warnings,
    };
  }

  const [ branch, head, dirty, index ] = await Promise.all([
    currentBranch(workspacePath).catch(() => null),
    headHash(workspacePath).catch(() => null),
    isDirty(workspacePath).catch(() => false),
    checkpointIndex(workspacePath),
  ]);
  const commits = await readCommitTimeline(workspacePath, maxCommits, index);
  const resolvedHead = head ? commits.find((entry) => entry.hash === head) ?? (await headEntry(workspacePath, head, index)) : null;
  if (head && resolvedHead === null) warnings.push('HEAD is outside the returned commit window and could not be read as an object');

  return {
    ok: true,
    workspace: workspacePath,
    source,
    sessionId,
    isRepo: true,
    branch,
    head: resolvedHead,
    isDirty: dirty,
    commits,
    capturedAt,
    error: null,
    warnings,
  };
}

/** Read one HEAD commit that fell outside the requested timeline window. */
async function headEntry(
  workspacePath: string,
  hash: string,
  index: Map<string, CheckpointRef>,
): Promise<CommitEntry | null> {
  const raw = await git(workspacePath, [ 'show', '--no-patch', '--format=%ct%x1f%cI%x1f%s', hash ]).catch(() => null);
  if (raw === null) return null;
  const [ committedSeconds, committedIso, ...subjectParts ] = raw.trim().split('\x1f');
  const seconds = Number.parseInt(committedSeconds ?? '', 10);
  const committedAtMs = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(committedIso ?? '');
  return {
    hash,
    short: hash.slice(0, 7),
    subject: subjectParts.join('\x1f').trim(),
    committedAt: committedIso ?? '',
    committedAtMs: Number.isFinite(committedAtMs) ? committedAtMs : 0,
    checkpoint: index.get(hash) ?? null,
  };
}

/** Write one JSON response with the headers the badge expects. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-length', String(Buffer.byteLength(payload)));
  res.end(payload);
}

/** Read one query parameter, treating empty strings as absent. */
function queryParam(url: URL, key: string): string | null {
  const value = url.searchParams.get(key);
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Serve one `GET /api/agent-checkpoint/git` request. */
export async function handleGitRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: AgentCheckpointHostConfig = {},
): Promise<void> {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    sendJson(res, 403, { ok: false, error: 'forbidden', message: 'agent-checkpoint only answers loopback requests' });
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD');
    sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }

  let url: URL;
  try {
    url = new URL(req.url ?? ROUTE_PATH, 'http://localhost');
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid_request_target' });
    return;
  }

  const resolution = await resolveWorkspace({
    workspace: queryParam(url, 'workspace'),
    sessionId: queryParam(url, 'session'),
    config,
  });

  const snapshot = await buildGitSnapshot(resolution.workspace, {
    maxCommits: parseMaxCommits(queryParam(url, 'limit') ?? config.maxCommits ?? DEFAULT_MAX_COMMITS),
    source: resolution.source,
    sessionId: resolution.sessionId,
    warnings: resolution.warnings,
  });
  sendJson(res, 200, snapshot);
}

/** The JSON body of one {@link INIT_ROUTE_PATH} response. */
export interface InitResponse {
  ok: boolean;
  /** Absolute project that was initialised. */
  workspace: string;
  source: WorkspaceSource;
  sessionId: string | null;
  /** True when this call created the repository. */
  created: boolean;
  gitVersion: string | null;
  branch: string | null;
  head: string | null;
  gitignoreUpdated: boolean;
  excludeUpdated: boolean;
  storePath: string;
  configPath: string;
  configFound: boolean;
  nextSteps: string[];
  warnings: string[];
  initializedAt: string;
  error?: string;
  message?: string;
}

/**
 * Serve one `POST /api/agent-checkpoint/init` request.
 *
 * Enabling checkpoints writes `.gitignore`, `.git/info/exclude` and the
 * `.dsh-checkpoint/` store, and may run `git init`, so it is a two-step action:
 * the browser half only issues this request after the operator's second click,
 * and the route itself refuses to act without `?confirm=1`. Loopback-only, POST
 * only — a stray link or a refreshed page cannot trigger it.
 * @param req - incoming loopback request.
 * @param res - response owned by this handler.
 * @param config - host half configuration.
 */
export async function handleInitRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: AgentCheckpointHostConfig = {},
): Promise<void> {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) {
    sendJson(res, 403, { ok: false, error: 'forbidden', message: 'agent-checkpoint only answers loopback requests' });
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'POST') {
    res.setHeader('allow', 'POST');
    sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
    return;
  }

  let url: URL;
  try {
    url = new URL(req.url ?? INIT_ROUTE_PATH, 'http://localhost');
  } catch {
    sendJson(res, 400, { ok: false, error: 'invalid_request_target' });
    return;
  }

  const confirm = (queryParam(url, 'confirm') ?? '').toLowerCase();
  if (confirm !== '1' && confirm !== 'true') {
    sendJson(res, 400, {
      ok: false,
      error: 'confirmation_required',
      message:
        'enabling checkpoints writes .gitignore, .git/info/exclude and the .dsh-checkpoint store, and may create a repository; repeat the request with confirm=1 after the operator approves',
    });
    return;
  }

  const resolution = await resolveWorkspace({
    workspace: queryParam(url, 'workspace'),
    sessionId: queryParam(url, 'session'),
    config,
  });

  try {
    const service = new CheckpointService(resolution.workspace);
    const result = await service.initWorkspace(resolution.workspace);
    const body: InitResponse = {
      ok: true,
      workspace: result.workspace,
      source: resolution.source,
      sessionId: resolution.sessionId,
      created: result.created,
      gitVersion: result.gitVersion,
      branch: result.branch,
      head: result.head,
      gitignoreUpdated: result.gitignoreUpdated,
      excludeUpdated: result.excludeUpdated,
      storePath: result.storePath,
      configPath: result.configPath,
      configFound: result.configFound,
      nextSteps: result.nextSteps,
      warnings: [ ...resolution.warnings, ...result.warnings ],
      initializedAt: new Date().toISOString(),
    };
    sendJson(res, 200, body);
  } catch (error) {
    const code = error instanceof CheckpointError ? error.code : 'init_failed';
    const message = error instanceof Error ? error.message : String(error);
    // `workspace_not_repository_root` means the folder lives inside another
    // repository: conflating that with a plain failure would hide the fix.
    sendJson(res, code === 'workspace_not_repository_root' ? 409 : 400, {
      ok: false,
      error: code,
      message,
      workspace: resolution.workspace,
      source: resolution.source,
      sessionId: resolution.sessionId,
      warnings: resolution.warnings,
    });
  }
}

/**
 * Cordis plugin body: register the badge route.
 *
 * `ctx.effect` owns the disposer when it exists (the real host), and a bare
 * registration covers the test harnesses that only provide `webServer`.
 */
export function apply(ctx: PluginContextLike, rawConfig: unknown = {}): void {
  const config = normalizeHostConfig(rawConfig);
  const register = () => {
    const disposers = [
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: (req, res) => handleGitRequest(req, res, config),
      }),
      ctx.webServer.register({
        kind: 'exact',
        path: INIT_ROUTE_PATH,
        handler: (req, res) => handleInitRequest(req, res, config),
      }),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  };
  if (typeof ctx.effect === 'function') ctx.effect(register, 'agent-checkpoint: git badge routes');
  else register();
}
