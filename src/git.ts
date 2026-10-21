/**
 * Thin, typed wrapper around the system `git` CLI.
 *
 * The plugin deliberately shells out to the native git binary instead of
 * embedding a git library, per the requirement document ("系统原生 git cli，不引入
 * 重型 git 依赖"). Every call therefore needs defensive handling: git is looked
 * up on PATH, its version gates optional subcommands, and stderr is surfaced
 * verbatim so operators can act on real git diagnostics.
 *
 * @module dsh-plugin-agent-checkpoint/git
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { FileChange } from './types.js';

/** Hash of the empty tree; the diff base for a repository without commits. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Default per-command timeout. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Failure raised when a git invocation exits non-zero. */
export class GitError extends Error {
  readonly args: string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;

  constructor(args: string[], exitCode: number | null, stderr: string, stdout: string) {
    super(`git ${args.join(' ')} failed (exit ${exitCode ?? 'null'}): ${stderr.trim() || stdout.trim()}`);
    this.name = 'GitError';
    this.args = args;
    this.exitCode = exitCode;
    this.stderr = stderr;
    this.stdout = stdout;
  }
}

/** Environment used for every git invocation. */
function gitEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_PAGER: 'cat',
    GIT_OPTIONAL_LOCKS: '0',
    LC_ALL: 'C',
    ...extra,
  };
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Run git and capture output. Throws {@link GitError} unless `allowFailure` is
 * set, in which case the raw result is returned for the caller to inspect.
 */
export function runGit(
  cwd: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; allowFailure?: boolean; timeoutMs?: number } = {},
): Promise<GitResult> {
  const fullArgs = [ '-c', 'core.quotepath=false', '--no-pager', ...args ];
  return new Promise<GitResult>((resolve, reject) => {
    execFile(
      'git',
      fullArgs,
      {
        cwd,
        env: gitEnv(options.env),
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : String(stdout ?? '');
        const err = typeof stderr === 'string' ? stderr : String(stderr ?? '');
        if (error) {
          const errno = error as NodeJS.ErrnoException & { code?: number | string };
          const exitCode = typeof errno.code === 'number' ? errno.code : null;
          if (options.allowFailure) {
            resolve({ stdout: out, stderr: err, code: exitCode ?? 1 });
            return;
          }
          reject(new GitError(fullArgs, exitCode, err, out));
          return;
        }
        resolve({ stdout: out, stderr: err, code: 0 });
      },
    );
  });
}

/** Convenience wrapper returning trimmed stdout. */
export async function git(cwd: string, args: string[], options?: Parameters<typeof runGit>[2]): Promise<string> {
  const result = await runGit(cwd, args, options);
  return result.stdout.trim();
}

let cachedVersion: string | null = null;

/** Parse `git --version` into a comparable tuple, or null when git is absent. */
export async function gitVersion(cwd: string = process.cwd()): Promise<string | null> {
  if (cachedVersion !== null) return cachedVersion;
  try {
    const out = await git(cwd, [ '--version' ]);
    cachedVersion = out;
    return out;
  } catch {
    return null;
  }
}

/** Numeric version tuple, e.g. `[2, 54, 0]`; `null` when git is unavailable. */
export async function gitVersionTuple(cwd?: string): Promise<number[] | null> {
  const raw = await gitVersion(cwd);
  if (!raw) return null;
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
  if (!match) return null;
  return [ Number(match[1]), Number(match[2]), Number(match[3] ?? 0) ];
}

function versionAtLeast(tuple: number[] | null, major: number, minor: number): boolean {
  if (!tuple) return false;
  if (tuple[0] !== major) return tuple[0] > major;
  return tuple[1] >= minor;
}

/**
 * Capability report used to choose between `git switch` and `git checkout`.
 * `git switch` landed in git 2.23; older installations fall back.
 */
export interface GitCapabilities {
  available: boolean;
  version: string | null;
  supportsSwitch: boolean;
  /** true when `git init` accepts `-b` (git >= 2.28). */
  supportsInitBranch: boolean;
}

export async function capabilities(): Promise<GitCapabilities> {
  const tuple = await gitVersionTuple();
  return {
    available: tuple !== null,
    version: await gitVersion(),
    supportsSwitch: versionAtLeast(tuple, 2, 23),
    supportsInitBranch: versionAtLeast(tuple, 2, 28),
  };
}

/** True when `cwd` is inside a git work tree. */
export async function isInsideWorkTree(cwd: string): Promise<boolean> {
  try {
    const out = await git(cwd, [ 'rev-parse', '--is-inside-work-tree' ], { allowFailure: true });
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/** Absolute path of the work-tree root, or null when not a repository. */
export async function topLevel(cwd: string): Promise<string | null> {
  const result = await runGit(cwd, [ 'rev-parse', '--show-toplevel' ], { allowFailure: true });
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

/** Absolute path of the git directory (`<root>/.git` or a worktree gitdir). */
export async function gitDir(cwd: string): Promise<string | null> {
  const result = await runGit(cwd, [ 'rev-parse', '--absolute-git-dir' ], { allowFailure: true });
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

/** Initialise a repository when `cwd` is not already one. */
export async function initRepo(cwd: string): Promise<{ created: boolean; branch: string | null }> {
  if (await isInsideWorkTree(cwd)) {
    return { created: false, branch: await currentBranch(cwd) };
  }
  const capsOut = await capabilities();
  const args = capsOut.supportsInitBranch ? [ 'init', '--initial-branch=main' ] : [ 'init' ];
  await git(cwd, args);
  return { created: true, branch: await currentBranch(cwd) };
}

/** Current branch name, or null when HEAD is detached / unborn. */
export async function currentBranch(cwd: string): Promise<string | null> {
  const symref = await runGit(cwd, [ 'symbolic-ref', '--quiet', '--short', 'HEAD' ], { allowFailure: true });
  if (symref.code === 0) {
    const name = symref.stdout.trim();
    if (name.length > 0) return name;
  }
  const short = await runGit(cwd, [ 'rev-parse', '--abbrev-ref', 'HEAD' ], { allowFailure: true });
  if (short.code !== 0) return null;
  const name = short.stdout.trim();
  return name === 'HEAD' || name.length === 0 ? null : name;
}

/** Commit hash of HEAD, or null when the repository has no commits yet. */
export async function headHash(cwd: string): Promise<string | null> {
  const result = await runGit(cwd, [ 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}' ], { allowFailure: true });
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return /^[0-9a-f]{7,64}$/.test(value) ? value : null;
}

/** `git log -1 --format=%s`, or null without commits. */
export async function headSubject(cwd: string): Promise<string | null> {
  const result = await runGit(cwd, [ 'log', '-1', '--format=%s' ], { allowFailure: true });
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

export interface StatusEntry {
  /** Two-letter porcelain status, e.g. `M `, `??`, `R `. */
  code: string;
  path: string;
  /** Original path for renames/copies. */
  from?: string;
}

/** Parse `git status --porcelain=v1 -z` entries. */
export function parsePorcelainZ(raw: string): StatusEntry[] {
  const entries: StatusEntry[] = [];
  const tokens = raw.split('\0');
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.length < 4) continue;
    const code = token.slice(0, 2);
    const filePath = token.slice(3);
    if (code[0] === 'R' || code[0] === 'C') {
      const from = tokens[index + 1];
      index += 1;
      entries.push({ code, path: filePath, from });
      continue;
    }
    entries.push({ code, path: filePath });
  }
  return entries;
}

/** Working-tree status entries, excluding ignored files. */
export async function statusEntries(cwd: string): Promise<StatusEntry[]> {
  const result = await runGit(cwd, [ 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none' ], {
    allowFailure: true,
  });
  if (result.code !== 0) return [];
  return parsePorcelainZ(result.stdout);
}

/** True when the work tree has any staged, unstaged, or untracked change. */
export async function isDirty(cwd: string): Promise<boolean> {
  return (await statusEntries(cwd)).length > 0;
}

/** Map porcelain codes to the single-letter codes used in previews. */
export function shortStatus(code: string): string {
  if (code === '??') return 'A';
  if (code.includes('R')) return 'R';
  if (code.includes('C')) return 'C';
  if (code.includes('D')) return 'D';
  if (code.includes('A')) return 'A';
  if (code.includes('M')) return 'M';
  if (code.includes('T')) return 'T';
  return code.trim() || '?';
}

/** `git diff --name-status` style change list between two tree-ish objects. */
export async function changedFilesBetween(cwd: string, base: string, tree: string): Promise<FileChange[]> {
  const result = await runGit(cwd, [ 'diff', '--name-status', '--no-renames', '-z', base, tree ], { allowFailure: true });
  if (result.code !== 0) return [];
  const files: FileChange[] = [];
  const tokens = result.stdout.split('\0').filter((token) => token.length > 0);
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const status = tokens[index]!;
    const filePath = tokens[index + 1]!;
    files.push({ path: filePath, status: status.slice(0, 1) });
  }
  return files;
}

/** Unified diff between two tree-ish objects, optionally limited to a stat. */
export async function diffBetween(
  cwd: string,
  base: string,
  tree: string,
  options: { stat?: boolean; nameOnly?: boolean; maxChars?: number } = {},
): Promise<string> {
  const args = [ 'diff', '--no-color', '--no-ext-diff' ];
  if (options.stat) args.push('--stat');
  if (options.nameOnly) args.push('--name-only');
  args.push(base, tree);
  const result = await runGit(cwd, args, { allowFailure: true });
  const text = result.stdout;
  if (options.maxChars !== undefined && text.length > options.maxChars) {
    return `${text.slice(0, options.maxChars)}\n…[diff truncated at ${options.maxChars} characters]`;
  }
  return text;
}

/**
 * Capture a tree object for the current working-tree state without touching
 * HEAD, the real index, or the user's branch.
 *
 * A separate index file is used so staged-but-uncommitted user state remains
 * exactly as it was before the snapshot.
 */
export async function writeWorktreeTree(
  cwd: string,
  indexPath: string,
  addArgs: string[] = [ 'add', '--all', '--', '.' ],
): Promise<string> {
  await mkdir(path.dirname(indexPath), { recursive: true });
  await rm(indexPath, { force: true });
  const env = { GIT_INDEX_FILE: indexPath };
  await runGit(cwd, [ ...addArgs ], { env });
  const tree = await git(cwd, [ 'write-tree' ], { env });
  await rm(indexPath, { force: true });
  return tree.trim();
}

/** Create a commit object (dangling unless a ref points at it). */
export async function commitObject(
  cwd: string,
  tree: string,
  parents: string[],
  message: string,
): Promise<string> {
  const args = [ 'commit-tree', tree ];
  for (const parent of parents) args.push('-p', parent);
  args.push('-m', message);
  const hash = await git(cwd, args);
  return hash.trim();
}

/** Create or move a ref, anchoring objects so `git gc` cannot prune them. */
export async function updateRef(cwd: string, ref: string, hash: string): Promise<void> {
  await git(cwd, [ 'update-ref', ref, hash ]);
}

/** Delete a ref; missing refs are tolerated. */
export async function deleteRef(cwd: string, ref: string): Promise<void> {
  await runGit(cwd, [ 'update-ref', '-d', ref ], { allowFailure: true });
}

/** Resolve any revision to a commit hash, or null. */
export async function revParseCommit(cwd: string, rev: string): Promise<string | null> {
  const result = await runGit(cwd, [ 'rev-parse', '--verify', '--quiet', `${rev}^{commit}` ], { allowFailure: true });
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

/** True when `ancestor` is reachable from `descendant`. */
export async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  const result = await runGit(cwd, [ 'merge-base', '--is-ancestor', ancestor, descendant ], { allowFailure: true });
  return result.code === 0;
}

/** Stage everything and create a real commit; returns the new commit hash. */
export async function commitAll(cwd: string, message: string): Promise<string> {
  await runGit(cwd, [ 'add', '--all', '--', '.' ]);
  await runGit(cwd, [ 'commit', '--no-verify', '-m', message ]);
  const hash = await headHash(cwd);
  if (!hash) throw new GitError([ 'commit' ], null, 'commit succeeded but HEAD is unset', '');
  return hash;
}

/** Hard-reset the branch and work tree to `hash`. */
export async function resetHard(cwd: string, hash: string): Promise<void> {
  await runGit(cwd, [ 'reset', '--hard', hash ]);
}

/** List local branch names. */
export async function listBranches(cwd: string): Promise<string[]> {
  const result = await runGit(cwd, [ 'for-each-ref', '--format=%(refname:short)', 'refs/heads' ], { allowFailure: true });
  if (result.code !== 0) return [];
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Validate a branch name using git's own rules; returns null when invalid. */
export async function validateBranchName(cwd: string, name: string): Promise<string | null> {
  const result = await runGit(cwd, [ 'check-ref-format', '--branch', name ], { allowFailure: true });
  if (result.code !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}

/** Create a branch pointing at `startPoint`. */
export async function createBranch(cwd: string, name: string, startPoint: string): Promise<void> {
  await runGit(cwd, [ 'branch', '--no-track', name, startPoint ]);
}

/** Check out an existing branch, returning the command flavour used. */
export async function switchBranch(cwd: string, name: string): Promise<'switch' | 'checkout'> {
  const capsOut = await capabilities();
  if (capsOut.supportsSwitch) {
    await runGit(cwd, [ 'switch', name ]);
    return 'switch';
  }
  await runGit(cwd, [ 'checkout', name ]);
  return 'checkout';
}

/** Read the (possibly absent) exclude file for this repository. */
async function readExclude(gitDirPath: string): Promise<string> {
  try {
    return await readFile(path.join(gitDirPath, 'info', 'exclude'), 'utf8');
  } catch {
    return '';
  }
}

export const EXCLUDE_BLOCK_START = '# >>> dsh-agent-checkpoint managed block (do not edit) >>>';
export const EXCLUDE_BLOCK_END = '# <<< dsh-agent-checkpoint managed block <<<';

/**
 * Rewrite the managed block of `.git/info/exclude` with `patterns`.
 *
 * The block is delimited so user content above and below it is preserved
 * verbatim across repeated runs.
 */
export async function writeExcludeBlock(gitDirPath: string, patterns: string[]): Promise<{ changed: boolean }> {
  const excludePath = path.join(gitDirPath, 'info', 'exclude');
  const current = await readExclude(gitDirPath);
  const lines = current.split('\n');
  const startIndex = lines.indexOf(EXCLUDE_BLOCK_START);
  const endIndex = lines.indexOf(EXCLUDE_BLOCK_END);
  let without: string;
  if (startIndex !== -1 && endIndex !== -1 && endIndex > startIndex) {
    without = [ ...lines.slice(0, startIndex), ...lines.slice(endIndex + 1) ].join('\n');
  } else {
    without = current;
  }
  const block = [
    EXCLUDE_BLOCK_START,
    ...patterns.map((pattern) => `/${pattern.replace(/^\/+/, '')}/`),
    EXCLUDE_BLOCK_END,
  ].join('\n');
  const base = without.replace(/\s+$/, '');
  const next = base.length > 0 ? `${base}\n${block}\n` : `${block}\n`;
  if (next === current) return { changed: false };
  await mkdir(path.dirname(excludePath), { recursive: true });
  await writeFile(excludePath, next, 'utf8');
  return { changed: true };
}

/**
 * Ensure a repository-local commit identity exists.
 *
 * `git commit` and `git commit-tree` both refuse to run without user.name /
 * user.email. Freshly `git init`-ed workspaces on a clean machine have neither,
 * so a placeholder identity is written *only* when the values are unset, and the
 * caller is told that it happened.
 */
export async function ensureIdentity(
  cwd: string,
  placeholder: { name: string; email: string } = {
    name: 'dsh-agent-checkpoint',
    email: 'dsh-agent-checkpoint@localhost',
  },
): Promise<{ configured: string[]; warnings: string[] }> {
  const configured: string[] = [];
  const warnings: string[] = [];
  for (const [ key, value ] of [ [ 'user.name', placeholder.name ], [ 'user.email', placeholder.email ] ] as const) {
    const existing = await runGit(cwd, [ 'config', '--get', key ], { allowFailure: true });
    if (existing.code === 0 && existing.stdout.trim().length > 0) continue;
    try {
      await git(cwd, [ 'config', key, value ]);
      configured.push(key);
    } catch (error) {
      warnings.push(`could not set ${key}: ${(error as Error).message}`);
    }
  }
  if (configured.length > 0) {
    warnings.push(
      `repository-local git identity was unset; wrote ${configured.join(', ')}. Set your own with \`git config ${configured[0]} <value>\` before confirming checkpoints.`,
    );
  }
  return { configured, warnings };
}

/** Ensure a repository root exists at `workspacePath`. */
export async function ensureDirectory(workspacePath: string): Promise<void> {
  const info = await stat(workspacePath).catch(() => null);
  if (!info) throw new Error(`workspace does not exist: ${workspacePath}`);
  if (!info.isDirectory()) throw new Error(`workspace is not a directory: ${workspacePath}`);
}
