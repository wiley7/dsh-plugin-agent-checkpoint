/**
 * Shared test helpers: throwaway workspaces with a real git binary.
 *
 * Tests never touch the developer's real `$DSH_HOME`: every suite points
 * `DSH_HOME` at a fresh temp directory before exercising session capture.
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runGit } from '../git.js';

export interface TempWorkspace {
  /** Absolute workspace directory. */
  dir: string;
  /** Absolute fake `$DSH_HOME`. */
  dshHome: string;
  /** Remove the workspace and restore `DSH_HOME`. */
  cleanup: () => Promise<void>;
}

/** Create an isolated workspace plus a fake DSH home. */
export async function makeWorkspace(prefix = 'ckpt-test-'): Promise<TempWorkspace> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const dir = path.join(root, 'workspace');
  const dshHome = path.join(root, 'dsh-home');
  await mkdir(dir, { recursive: true });
  await mkdir(path.join(dshHome, 'sessions'), { recursive: true });
  const previousHome = process.env.DSH_HOME;
  const previousSessionId = process.env.DSH_SESSION_ID;
  process.env.DSH_HOME = dshHome;
  delete process.env.DSH_SESSION_ID;
  return {
    dir,
    dshHome,
    cleanup: async () => {
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      if (previousSessionId === undefined) delete process.env.DSH_SESSION_ID;
      else process.env.DSH_SESSION_ID = previousSessionId;
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Write a file inside the workspace, creating parent directories. */
export async function writeWorkspaceFile(dir: string, relative: string, content: string): Promise<string> {
  const target = path.join(dir, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  return target;
}

/** Run git in a workspace and return trimmed stdout. */
export async function gitOut(dir: string, args: string[]): Promise<string> {
  const result = await runGit(dir, args);
  return result.stdout.trim();
}

/** `git log --format=%s -1`, or null when the repo has no commits. */
export async function headSubject(dir: string): Promise<string | null> {
  const result = await runGit(dir, [ 'log', '-1', '--format=%s' ], { allowFailure: true });
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

/** `git rev-parse HEAD`, or null when the repo has no commits. */
export async function headHash(dir: string): Promise<string | null> {
  const result = await runGit(dir, [ 'rev-parse', '--verify', '--quiet', 'HEAD' ], { allowFailure: true });
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

/** Minimal synthetic DSH session record list. */
export function sampleSessionEvents(options: {
  sessionId: string;
  cwd: string;
}): Array<Record<string, unknown>> {
  return [
    { type: 'session', version: 4, id: options.sessionId, cwd: options.cwd, agentPreset: 'planner' },
    {
      type: 'user/message',
      seq: 1,
      time: 1_700_000_000_000,
      data: { content: [ { type: 'text', text: 'Build the checkpoint plugin' } ], source: { kind: 'user' } },
    },
    {
      type: 'user/message',
      seq: 2,
      time: 1_700_000_001_000,
      data: {
        content: [ { type: 'text', text: 'Current working directory: /tmp/x' } ],
        source: { kind: 'runtime-context', form: 'snapshot' },
      },
    },
    {
      type: 'assistant/message',
      seq: 3,
      time: 1_700_000_002_000,
      data: {
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will scaffold the project.' },
            { type: 'tool-call', name: 'bash' },
          ],
        },
        stream: 'x'.repeat(50_000),
      },
    },
    { type: 'tool/call', seq: 4, data: { name: 'bash', arguments: { command: 'ls' } } },
    { type: 'tool/call', seq: 5, data: { name: 'bash', arguments: { command: 'pwd' } } },
    {
      type: 'tool/result',
      seq: 6,
      data: { message: { role: 'tool', content: [ { type: 'text', text: 'ok' } ] } },
    },
    {
      type: 'todo/write',
      seq: 7,
      data: {
        todos: [
          { content: 'scaffold project', status: 'completed' },
          { content: 'write tests', status: 'in_progress' },
        ],
      },
    },
    { type: 'step/end', seq: 8, data: {} },
  ];
}

/** Serialize records as JSONL. */
export function toJsonl(records: Array<Record<string, unknown>>): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}
