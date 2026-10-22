/**
 * Host-half tests: the loopback `/api/agent-checkpoint/git` route that feeds the
 * browser badge.
 *
 * The route is tiny but it is the only place where the plugin reads a
 * repository on behalf of the GUI, so these tests pin the parts that matter:
 * workspace resolution order, the commit timeline shape, checkpoint
 * annotation, the loopback/method fences, and the route registration the Cordis
 * `apply` performs.
 */

import assert from 'node:assert/strict';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { zstdCompressSync } from 'node:zlib';

import { runGit } from '../git.js';
import {
  DEFAULT_MAX_COMMITS,
  INIT_ROUTE_PATH,
  MAX_COMMITS_LIMIT,
  ROUTE_PATH,
  apply,
  buildGitSnapshot,
  checkpointIndex,
  createAutomaticCheckpoints,
  handleGitRequest,
  handleInitRequest,
  isLoopbackAddress,
  normalizeHostConfig,
  parseMaxCommits,
  resolveWorkspace,
} from '../host.js';
import { gitOut, makeWorkspace, sampleSessionEvents, toJsonl, writeWorkspaceFile, type TempWorkspace } from './helpers.js';

/** Captured HTTP response for the route tests. */
interface RecordedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

/** Minimal `ServerResponse` look-alike sufficient for the route handler. */
function fakeResponse(): { res: ServerResponse; recorded: RecordedResponse } {
  const recorded: RecordedResponse = { statusCode: 200, headers: {}, body: '' };
  const res = {
    set statusCode(value: number) {
      recorded.statusCode = value;
    },
    get statusCode() {
      return recorded.statusCode;
    },
    setHeader(name: string, value: string) {
      recorded.headers[name.toLowerCase()] = value;
      return res;
    },
    end(body?: string) {
      recorded.body = body ?? '';
      return res;
    },
  } as unknown as ServerResponse;
  return { res, recorded };
}

/** Minimal `IncomingMessage` look-alike (only the fields the handler reads). */
function fakeRequest(options: { url?: string; method?: string; remoteAddress?: string }): IncomingMessage {
  return {
    url: options.url ?? ROUTE_PATH,
    method: options.method ?? 'GET',
    socket: { remoteAddress: options.remoteAddress ?? '127.0.0.1' },
  } as unknown as IncomingMessage;
}

/** Parse a recorded JSON response body. */
function bodyOf(recorded: RecordedResponse): Record<string, unknown> {
  return JSON.parse(recorded.body) as Record<string, unknown>;
}

/** Configure a throwaway repository identity so commits never depend on the machine. */
async function configureIdentity(dir: string): Promise<void> {
  await runGit(dir, [ 'config', 'user.name', 'Checkpoint Test' ]);
  await runGit(dir, [ 'config', 'user.email', 'checkpoint@test.invalid' ]);
}

/** Commit every pending change with a fixed message. */
async function commitAll(dir: string, message: string): Promise<void> {
  await runGit(dir, [ 'add', '-A' ]);
  await runGit(dir, [ 'commit', '-m', message ]);
}

/** Write a compressed DSH session log whose header carries `cwd`. */
async function writeSessionLog(dshHome: string, sessionId: string, cwd: string): Promise<string> {
  // DSH names the directory after the session id itself (`session-<uuid>`).
  const dir = path.join(dshHome, 'sessions', '--tmp--', sessionId.startsWith('session-') ? sessionId : `session-${sessionId}`);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const jsonl = toJsonl(sampleSessionEvents({ sessionId, cwd }));
  await writeFile(file, zstdCompressSync(Buffer.from(jsonl, 'utf8')));
  return file;
}

describe('isLoopbackAddress', () => {
  it('accepts IPv4 and IPv6 loopback forms and rejects everything else', () => {
    assert.equal(isLoopbackAddress('127.0.0.1'), true);
    assert.equal(isLoopbackAddress('127.0.0.2'), true);
    assert.equal(isLoopbackAddress('::1'), true);
    assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
    assert.equal(isLoopbackAddress('192.168.1.10'), false);
    assert.equal(isLoopbackAddress('::ffff:10.0.0.1'), false);
    assert.equal(isLoopbackAddress(undefined), false);
    assert.equal(isLoopbackAddress(null), false);
  });
});

describe('parseMaxCommits', () => {
  it('accepts numeric strings, clamps to the allowed window and falls back on garbage', () => {
    assert.equal(parseMaxCommits('30'), 30);
    assert.equal(parseMaxCommits(12), 12);
    assert.equal(parseMaxCommits('0'), DEFAULT_MAX_COMMITS);
    assert.equal(parseMaxCommits(-5), DEFAULT_MAX_COMMITS);
    assert.equal(parseMaxCommits('9999'), MAX_COMMITS_LIMIT);
    assert.equal(parseMaxCommits('abc'), DEFAULT_MAX_COMMITS);
    assert.equal(parseMaxCommits(undefined), DEFAULT_MAX_COMMITS);
    assert.equal(parseMaxCommits('abc', 7), 7);
  });
});

describe('normalizeHostConfig', () => {
  it('drops an empty workspace and non-string values instead of failing activation', () => {
    assert.deepEqual(normalizeHostConfig(undefined), {});
    assert.deepEqual(normalizeHostConfig({ workspace: '   ' }), {});
    assert.deepEqual(normalizeHostConfig({ workspace: 42 }), {});
    assert.deepEqual(normalizeHostConfig({ workspace: '/tmp/project' }), { workspace: '/tmp/project' });
    assert.deepEqual(normalizeHostConfig({ maxCommits: '8' }), { maxCommits: 8 });
  });
});

describe('resolveWorkspace', () => {
  it('prefers an absolute workspace query over every other source', async () => {
    const resolution = await resolveWorkspace({
      workspace: '/tmp',
      config: { workspace: '/usr' },
      env: { DSH_WORKSPACE: '/etc' },
      cwd: '/var',
    });
    assert.equal(resolution.source, 'query');
    assert.equal(resolution.workspace, await realpath('/tmp'));
    assert.deepEqual(resolution.warnings, []);
  });

  it('ignores a relative query but keeps it as a warning', async () => {
    const resolution = await resolveWorkspace({ workspace: 'relative/path', env: {}, cwd: '/tmp' });
    assert.equal(resolution.source, 'cwd');
    assert.equal(resolution.workspace, await realpath('/tmp'));
    assert.match(resolution.warnings.join(' '), /non-absolute workspace query/);
  });

  it('falls through config, then $DSH_WORKSPACE, then cwd', async () => {
    const fromConfig = await resolveWorkspace({ config: { workspace: '/usr' }, env: { DSH_WORKSPACE: '/etc' }, cwd: '/var' });
    assert.equal(fromConfig.source, 'config');
    assert.equal(fromConfig.workspace, await realpath('/usr'));

    const fromEnv = await resolveWorkspace({ env: { DSH_WORKSPACE: '/etc' }, cwd: '/var' });
    assert.equal(fromEnv.source, 'env');
    assert.equal(fromEnv.workspace, await realpath('/etc'));

    const fromCwd = await resolveWorkspace({ env: {}, cwd: '/var' });
    assert.equal(fromCwd.source, 'cwd');
    assert.equal(fromCwd.workspace, await realpath('/var'));
  });
});

describe('buildGitSnapshot', () => {
  let workspace: TempWorkspace;

  before(async () => {
    workspace = await makeWorkspace('ckpt-host-');
    await runGit(workspace.dir, [ 'init', '--initial-branch=main' ]);
    await configureIdentity(workspace.dir);
    await writeWorkspaceFile(workspace.dir, 'README.md', 'first\n');
    await commitAll(workspace.dir, 'first commit');
    await writeWorkspaceFile(workspace.dir, 'README.md', 'second\n');
    await commitAll(workspace.dir, 'second commit');
    await writeWorkspaceFile(workspace.dir, 'notes.md', 'third\n');
    await commitAll(workspace.dir, 'third commit');
  });

  after(async () => {
    await workspace.cleanup();
  });

  it('reports branch, HEAD and the commit timeline newest first', async () => {
    const snapshot = await buildGitSnapshot(workspace.dir, { source: 'query' });
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.isRepo, true);
    assert.equal(snapshot.branch, 'main');
    assert.equal(snapshot.error, null);
    assert.equal(snapshot.source, 'query');
    assert.equal(snapshot.commits.length, 3);
    assert.deepEqual(snapshot.commits.map((entry) => entry.subject), [ 'third commit', 'second commit', 'first commit' ]);

    const head = await runGit(workspace.dir, [ 'rev-parse', 'HEAD' ]);
    assert.equal(snapshot.head?.hash, head.stdout.trim());
    assert.equal(snapshot.head?.short, head.stdout.trim().slice(0, 7));
    assert.equal(snapshot.head?.subject, 'third commit');
    assert.equal(snapshot.head?.checkpoint, null);
    assert.equal(snapshot.isDirty, false);
    assert.ok(snapshot.head && snapshot.head.committedAtMs > 0);
    assert.match(snapshot.head?.committedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
  });

  it('flags uncommitted work without failing', async () => {
    await writeWorkspaceFile(workspace.dir, 'dirty.txt', 'uncommitted\n');
    const snapshot = await buildGitSnapshot(workspace.dir);
    assert.equal(snapshot.ok, true);
    assert.equal(snapshot.isDirty, true);
    await runGit(workspace.dir, [ 'clean', '-fd' ]);
  });

  it('keeps HEAD even when the requested window is shorter than its distance', async () => {
    const snapshot = await buildGitSnapshot(workspace.dir, { maxCommits: 1 });
    assert.equal(snapshot.commits.length, 1);
    assert.equal(snapshot.head?.subject, 'third commit');
  });

  it('annotates the commit that a confirmed checkpoint was created from', async () => {
    const head = (await runGit(workspace.dir, [ 'rev-parse', 'HEAD' ])).stdout.trim();
    const recordsDir = path.join(workspace.dir, '.dsh-checkpoint', 'checkpoints');
    await mkdir(recordsDir, { recursive: true });
    const record = {
      id: 'ckpt-1700000000000-abcd1234',
      status: 'confirmed',
      title: 'Release candidate',
      tags: [ 'release' ],
      remark: 'created by the test suite',
      createdAt: new Date(1_700_000_000_000).toISOString(),
      updatedAt: new Date(1_700_000_000_000).toISOString(),
      workspace: workspace.dir,
      branch: 'main',
      baseCommit: head,
      treeHash: null,
      draftCommit: null,
      commitHash: head,
      parentCommit: null,
      files: [],
      diffStat: '',
      diff: '',
      diffTruncated: false,
      diffPath: null,
      contextPath: null,
      contextSummary: '',
      sessionId: null,
      anchorRef: null,
    };
    await writeFile(path.join(recordsDir, `${record.id}.json`), JSON.stringify(record, null, 2), 'utf8');

    const index = await checkpointIndex(workspace.dir);
    assert.equal(index.get(head)?.id, record.id);
    assert.deepEqual(index.get(head)?.tags, [ 'release' ]);

    const snapshot = await buildGitSnapshot(workspace.dir);
    assert.equal(snapshot.head?.checkpoint?.id, record.id);
    assert.equal(snapshot.head?.checkpoint?.title, 'Release candidate');
  });

  it('reports a clean non-repository answer instead of throwing', async () => {
    const plain = await makeWorkspace('ckpt-host-plain-');
    try {
      const snapshot = await buildGitSnapshot(plain.dir);
      assert.equal(snapshot.ok, false);
      assert.equal(snapshot.isRepo, false);
      assert.equal(snapshot.error, 'not_a_git_repo');
      assert.equal(snapshot.head, null);
      assert.deepEqual(snapshot.commits, []);
    } finally {
      await plain.cleanup();
    }
  });

  it('returns an empty timeline for a repository without commits', async () => {
    const empty = await makeWorkspace('ckpt-host-empty-');
    try {
      await runGit(empty.dir, [ 'init', '--initial-branch=main' ]);
      const snapshot = await buildGitSnapshot(empty.dir);
      assert.equal(snapshot.ok, true);
      assert.equal(snapshot.isRepo, true);
      assert.equal(snapshot.branch, 'main');
      assert.equal(snapshot.head, null);
      assert.deepEqual(snapshot.commits, []);
    } finally {
      await empty.cleanup();
    }
  });
});

describe('per-message checkpoint attribution', () => {
  /** Three turns, one checkpoint after turn 1 and one after turn 2. */
  const T = { t1s: 1_700_000_000_000, t1m: 1_700_000_060_000, t1e: 1_700_000_120_000 };

  /** Write a three-turn session log and return its path. */
  async function writeTimelineLog(dshHome: string, sessionId: string, cwd: string): Promise<string> {
    const dir = path.join(dshHome, 'sessions', '--tmp--', `session-${sessionId}`);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    const first = T.t1s;
    const second = first + 1_000_000;
    const third = second + 1_000_000;
    const events = [
      { type: 'session', version: 4, id: sessionId, cwd, agentPreset: 'planner' },
      { type: 'turn/start', seq: 4, time: first, data: { turn: 1 } },
      { type: 'assistant/message', seq: 16, time: first + 60_000, data: { turn: 1, message: { id: 'msg-1', content: [ { type: 'text', text: 'scaffolded' } ] } } },
      { type: 'turn/end', seq: 23, time: first + 120_000, data: { turn: 1 } },
      { type: 'turn/start', seq: 27, time: second, data: { turn: 2 } },
      { type: 'assistant/message', seq: 30, time: second + 60_000, data: { turn: 2, message: { id: 'msg-2', content: [ { type: 'text', text: 'wrote tests' } ] } } },
      { type: 'turn/end', seq: 40, time: second + 120_000, data: { turn: 2 } },
      // A quiet third round that produced no snapshot of its own.
      { type: 'turn/start', seq: 44, time: third, data: { turn: 3 } },
      { type: 'assistant/message', seq: 46, time: third + 60_000, data: { turn: 3, message: { id: 'msg-3', content: [ { type: 'text', text: 'answered a question' } ] } } },
      { type: 'turn/end', seq: 50, time: third + 120_000, data: { turn: 3 } },
    ];
    await writeFile(file, zstdCompressSync(Buffer.from(toJsonl(events), 'utf8')));
    return file;
  }

  /** Store one checkpoint record, the way the MCP tools would. */
  async function storeCheckpoint(
    workspacePath: string,
    kind: 'drafts' | 'checkpoints',
    record: { id: string; title: string; createdAt: number; commitHash: string | null },
  ): Promise<void> {
    const dir = path.join(workspacePath, '.dsh-checkpoint', kind);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, `${record.id}.json`),
      JSON.stringify({
        id: record.id,
        status: kind === 'drafts' ? 'draft' : 'confirmed',
        title: record.title,
        tags: [],
        remark: '',
        createdAt: new Date(record.createdAt).toISOString(),
        updatedAt: new Date(record.createdAt).toISOString(),
        workspace: workspacePath,
        branch: 'main',
        commitHash: record.commitHash,
      }),
    );
  }

  it('names the snapshot that was current for each reply, never a later one', async () => {
    const workspace = await makeWorkspace('ckpt-attribution-');
    try {
      await runGit(workspace.dir, [ 'init', '--initial-branch=main' ]);
      await configureIdentity(workspace.dir);
      await writeWorkspaceFile(workspace.dir, 'app.ts', 'export const x = 1;\n');
      await commitAll(workspace.dir, 'initial import');
      const sessionFile = await writeTimelineLog(workspace.dshHome, 'session-attribution', workspace.dir);
      // Snapshot of turn 1 (still a draft) and of turn 2 (committed).
      await storeCheckpoint(workspace.dir, 'drafts', { id: 'draft-1700000120001-aaaa1111', title: 'Scaffold', createdAt: T.t1e + 1_000, commitHash: null });
      await storeCheckpoint(workspace.dir, 'checkpoints', { id: 'ckpt-1700001120001-bbbb2222', title: 'Tests', createdAt: T.t1e + 1_001_000, commitHash: 'deadbeef' });

      const snapshot = await buildGitSnapshot(workspace.dir, { sessionFile });
      const attribution = snapshot.attribution;
      assert.equal(attribution.length, 3);

      const first = attribution.find((entry) => entry.messageId === 'msg-1')!;
      assert.equal(first.checkpointId, 'draft-1700000120001-aaaa1111');
      assert.equal(first.status, 'draft');
      assert.equal(first.short, 'aaaa1111');
      assert.equal(first.inherited, false);
      assert.equal(first.fromTurn, 1);

      const second = attribution.find((entry) => entry.messageId === 'msg-2')!;
      assert.equal(second.checkpointId, 'ckpt-1700001120001-bbbb2222');
      assert.equal(second.status, 'confirmed');
      assert.equal(second.commitHash, 'deadbeef');
      assert.equal(second.inherited, false);

      // Turn 3 saved nothing, so its reply keeps reporting the snapshot still in force.
      const third = attribution.find((entry) => entry.messageId === 'msg-3')!;
      assert.equal(third.checkpointId, 'ckpt-1700001120001-bbbb2222');
      assert.equal(third.inherited, true);
      assert.equal(third.fromTurn, 2);
    } finally {
      await workspace.cleanup();
    }
  });

  it('answers with an empty attribution when no session log is at hand', async () => {
    const workspace = await makeWorkspace('ckpt-attribution-none-');
    try {
      await runGit(workspace.dir, [ 'init', '--initial-branch=main' ]);
      await configureIdentity(workspace.dir);
      await writeWorkspaceFile(workspace.dir, 'app.ts', 'export const x = 1;\n');
      await commitAll(workspace.dir, 'initial import');
      const snapshot = await buildGitSnapshot(workspace.dir, {});
      assert.deepEqual([ ...snapshot.attribution ], []);
    } finally {
      await workspace.cleanup();
    }
  });
});

describe('handleGitRequest', () => {
  let workspace: TempWorkspace;

  before(async () => {
    workspace = await makeWorkspace('ckpt-host-route-');
    await runGit(workspace.dir, [ 'init', '--initial-branch=main' ]);
    await configureIdentity(workspace.dir);
    await writeWorkspaceFile(workspace.dir, 'app.ts', 'export const x = 1;\n');
    await commitAll(workspace.dir, 'initial import');
    await writeSessionLog(workspace.dshHome, 'session-host-test', workspace.dir);
  });

  after(async () => {
    await workspace.cleanup();
  });

  it('refuses peers that are not on the loopback interface', async () => {
    const { res, recorded } = fakeResponse();
    await handleGitRequest(fakeRequest({ remoteAddress: '10.1.2.3' }), res);
    assert.equal(recorded.statusCode, 403);
    assert.equal(bodyOf(recorded).error, 'forbidden');
  });

  it('allows only GET and HEAD', async () => {
    const { res, recorded } = fakeResponse();
    await handleGitRequest(fakeRequest({ method: 'POST' }), res);
    assert.equal(recorded.statusCode, 405);
    assert.equal(recorded.headers.allow, 'GET, HEAD');
    assert.equal(bodyOf(recorded).error, 'method_not_allowed');
  });

  it('answers with the git snapshot and a no-store cache directive', async () => {
    const { res, recorded } = fakeResponse();
    await handleGitRequest(fakeRequest({ url: `${ROUTE_PATH}?workspace=${encodeURIComponent(workspace.dir)}` }), res);
    assert.equal(recorded.statusCode, 200);
    assert.equal(recorded.headers['cache-control'], 'no-store');
    assert.equal(recorded.headers['content-type'], 'application/json; charset=utf-8');
    const body = bodyOf(recorded);
    assert.equal(body.ok, true);
    assert.equal(body.branch, 'main');
    assert.equal(body.source, 'query');
    assert.equal((body.commits as unknown[]).length, 1);
    assert.equal((body.head as Record<string, unknown>).subject, 'initial import');
  });

  it('derives the workspace from the viewed session when no query names one', async () => {
    const { res, recorded } = fakeResponse();
    await handleGitRequest(
      fakeRequest({ url: `${ROUTE_PATH}?session=session-host-test&limit=5` }),
      res,
      { workspace: '/definitely/not/this/repo' },
    );
    assert.equal(recorded.statusCode, 200);
    const body = bodyOf(recorded);
    assert.equal(body.source, 'session');
    assert.equal(body.sessionId, 'session-host-test');
    assert.equal(body.workspace, await realpath(workspace.dir));
    assert.equal((body.commits as unknown[]).length, 1);
  });

  it('registers both exact routes and the automatic-checkpoint effect', () => {
    const registrations: Array<{ kind: string; path: string; handler?: unknown }> = [];
    const labels: Array<string | undefined> = [];
    let disposed = 0;
    const ctx = {
      webServer: {
        register(route: { kind: string; path: string; handler?: unknown }) {
          registrations.push(route);
          return () => {
            disposed += 1;
          };
        },
      },
      effect(run: () => () => void, label?: string) {
        labels.push(label);
        return run();
      },
    };
    apply(ctx as never, { workspace: workspace.dir });
    assert.deepEqual(registrations.map((route) => route.path), [ ROUTE_PATH, INIT_ROUTE_PATH ]);
    assert.ok(registrations.every((route) => route.kind === 'exact'));
    assert.equal(disposed, 0);
    assert.equal(labels.length, 2);
    assert.equal(labels[0], 'agent-checkpoint: git badge routes');
    assert.match(String(labels[1]), /automatic checkpoints/);
  });

  it('registers the settings namespace when the host serves settings', () => {
    const registrations: Array<{ namespace: string }> = [];
    const requested: string[][] = [];
    const ctx = {
      webServer: { register: () => () => undefined },
      effect: (run: () => () => void) => run(),
      inject(dependencies: string[], callback: (scoped: unknown) => void) {
        requested.push(dependencies);
        callback({
          settings: {
            register(namespace: string) {
              registrations.push({ namespace });
              return { get: () => ({ trigger: 'off', apply: 'draft', interval_turns: 5 }), watch: () => () => undefined };
            },
          },
        });
      },
      on: () => () => undefined,
    };
    apply(ctx as never, { workspace: workspace.dir });
    assert.deepEqual(requested, [ [ 'settings' ] ]);
    assert.deepEqual(registrations.map((entry) => entry.namespace), [ 'agent-checkpoint' ]);
  });

  it('degrades to no automation when the host exposes neither settings nor events', () => {
    const ctx = { webServer: { register: () => () => undefined } };
    assert.doesNotThrow(() => apply(ctx as never, { workspace: workspace.dir }));
  });
});

describe('createAutomaticCheckpoints', () => {
  /** Install a git identity so the automatic commit path can run anywhere. */
  async function repoWithFile() {
    const workspace = await makeWorkspace('ckpt-host-auto-');
    await runGit(workspace.dir, [ 'init', '-b', 'main' ]);
    await configureIdentity(workspace.dir);
    await writeWorkspaceFile(workspace.dir, 'app.txt', 'one\n');
    await commitAll(workspace.dir, 'initial import');
    return workspace;
  }

  /** Serve one session log whose header names `cwd`. */
  async function logFor(workspace: string, sessionId: string) {
    const dshHome = process.env.DSH_HOME;
    assert.ok(dshHome);
    await writeSessionLog(dshHome, sessionId, workspace);
  }

  it('saves a draft when a turn changed files', async () => {
    const workspace = await repoWithFile();
    await logFor(workspace.dir, 'session-auto-draft');
    const logs: string[] = [];
    const { engine, policy } = createAutomaticCheckpoints({ config: {}, log: (message) => logs.push(message) });
    policy.adopt({ trigger: 'file_change', apply: 'draft' });
    await writeWorkspaceFile(workspace.dir, 'app.txt', 'two\n');

    const outcome = await engine.handle({ id: 'session-auto-draft' }, { type: 'turn/end', data: { turn: 1 } });
    assert.equal(outcome.fired, true);
    assert.equal(outcome.fired === true && outcome.status, 'draft');
    const draftId = outcome.fired === true ? outcome.checkpointId : '';
    const { listAllCheckpoints } = await import('../store.js');
    const records = await listAllCheckpoints(workspace.dir);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.id, draftId);
    assert.equal(records[0]?.status, 'draft');
    assert.match(String(records[0]?.title), /Automatic checkpoint/);
    assert.match(String(records[0]?.remark), /changed files/);
    assert.deepEqual(records[0]?.tags, [ 'auto', 'file_change' ]);
    assert.match(logs.join('\n'), /automatic checkpoints: draft/);
  });

  it('commits in "apply: commit" mode, without any confirmation token', async () => {
    const workspace = await repoWithFile();
    await logFor(workspace.dir, 'session-auto-commit');
    const { engine, policy } = createAutomaticCheckpoints({ config: {}, log: () => undefined });
    policy.adopt({ trigger: 'turn', apply: 'commit' });
    await writeWorkspaceFile(workspace.dir, 'app.txt', 'three\n');

    const outcome = await engine.handle({ id: 'session-auto-commit' }, { type: 'turn/end', data: { turn: 4 } });
    assert.equal(outcome.fired, true);
    assert.equal(outcome.fired === true && outcome.status, 'confirmed');
    const subject = await gitOut(workspace.dir, [ 'log', '-1', '--pretty=%s' ]);
    assert.equal(subject.trim(), 'checkpoint: automatic save after turn 4');
    const head = await gitOut(workspace.dir, [ 'log', '-1', '--pretty=%H' ]);
    const { listAllCheckpoints } = await import('../store.js');
    const records = await listAllCheckpoints(workspace.dir);
    assert.equal(records[0]?.status, 'confirmed');
    assert.equal(records[0]?.commitHash, head.trim());
  });

  it('never uses the configured workspace when the session names none', async () => {
    const workspace = await repoWithFile();
    const { engine, policy } = createAutomaticCheckpoints({ config: { workspace: workspace.dir }, log: () => undefined });
    policy.adopt({ trigger: 'turn', apply: 'draft' });
    const outcome = await engine.handle({ id: 'session-without-log' }, { type: 'turn/end', data: { turn: 1 } });
    assert.deepEqual(outcome, { fired: false, reason: 'no_workspace', turn: 1 });
    const { listAllCheckpoints } = await import('../store.js');
    assert.deepEqual(await listAllCheckpoints(workspace.dir), []);
  });

  it('skips a session whose project is not a repository root', async () => {
    const workspace = await repoWithFile();
    const plain = await makeWorkspace('ckpt-host-auto-plain-');
    await logFor(plain.dir, 'session-auto-norepo');
    const { engine, policy } = createAutomaticCheckpoints({ config: {}, log: () => undefined });
    policy.adopt({ trigger: 'turn', apply: 'draft' });
    assert.deepEqual(await engine.handle({ id: 'session-auto-norepo' }, { type: 'turn/end', data: { turn: 1 } }), {
      fired: false,
      reason: 'not_a_repository',
      turn: 1,
    });
    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(`${plain.dir}/.git`), false);
    assert.ok(workspace.dir.length > 0);
  });
});

describe('handleInitRequest', () => {
  it('refuses peers that are not on the loopback interface', async () => {
    const { res, recorded } = fakeResponse();
    await handleInitRequest(fakeRequest({ method: 'POST', remoteAddress: '10.1.2.3', url: `${INIT_ROUTE_PATH}?confirm=1` }), res);
    assert.equal(recorded.statusCode, 403);
    assert.equal(bodyOf(recorded).error, 'forbidden');
  });

  it('allows only POST, so a link or a page load cannot initialise anything', async () => {
    const { res, recorded } = fakeResponse();
    await handleInitRequest(fakeRequest({ method: 'GET', url: `${INIT_ROUTE_PATH}?confirm=1` }), res);
    assert.equal(recorded.statusCode, 405);
    assert.equal(recorded.headers.allow, 'POST');
    assert.equal(bodyOf(recorded).error, 'method_not_allowed');
  });

  it('refuses to write without the operator confirmation flag', async () => {
    const workspace = await makeWorkspace('ckpt-host-init-unconfirmed-');
    try {
      for (const url of [ INIT_ROUTE_PATH, `${INIT_ROUTE_PATH}?confirm=0`, `${INIT_ROUTE_PATH}?workspace=${encodeURIComponent(workspace.dir)}` ]) {
        const { res, recorded } = fakeResponse();
        await handleInitRequest(fakeRequest({ method: 'POST', url }), res);
        assert.equal(recorded.statusCode, 400, url);
        assert.equal(bodyOf(recorded).error, 'confirmation_required', url);
      }
      // Nothing was created: the refusal precedes every write.
      await assert.rejects(runGit(workspace.dir, [ 'rev-parse', '--git-dir' ]));
    } finally {
      await workspace.cleanup();
    }
  });

  it('creates the repository, ignore rules and store for the confirmed project', async () => {
    const workspace = await makeWorkspace('ckpt-host-init-');
    try {
      const { res, recorded } = fakeResponse();
      await handleInitRequest(
        fakeRequest({ method: 'POST', url: `${INIT_ROUTE_PATH}?confirm=1&workspace=${encodeURIComponent(workspace.dir)}` }),
        res,
      );
      assert.equal(recorded.statusCode, 200, recorded.body);
      const body = bodyOf(recorded);
      assert.equal(body.ok, true);
      assert.equal(body.created, true);
      assert.equal(body.source, 'query');
      assert.equal(body.workspace, await realpath(workspace.dir));
      assert.equal(body.gitignoreUpdated, true);
      assert.equal(body.excludeUpdated, true);
      assert.equal(typeof body.storePath, 'string');
      // The only warning is the expected one: this call created the repository.
      assert.deepEqual(
        (body.warnings as string[]).filter((warning) => !warning.startsWith('initialised a new git repository')),
        [],
      );

      // The same project is a repository now, so the badge has something to show.
      const snapshot = await buildGitSnapshot(workspace.dir);
      assert.equal(snapshot.isRepo, true);
      assert.equal(snapshot.branch, 'main');

      const again = fakeResponse();
      await handleInitRequest(
        fakeRequest({ method: 'POST', url: `${INIT_ROUTE_PATH}?confirm=1&workspace=${encodeURIComponent(workspace.dir)}` }),
        again.res,
      );
      assert.equal(again.recorded.statusCode, 200);
      assert.equal(bodyOf(again.recorded).created, false, 'a second call is idempotent');
    } finally {
      await workspace.cleanup();
    }
  });

  it('initialises the project the viewed session points at', async () => {
    const workspace = await makeWorkspace('ckpt-host-init-session-');
    try {
      await writeSessionLog(workspace.dshHome, 'session-init-viewed', workspace.dir);
      const { res, recorded } = fakeResponse();
      await handleInitRequest(
        fakeRequest({ method: 'POST', url: `${INIT_ROUTE_PATH}?confirm=1&session=session-init-viewed` }),
        res,
        { workspace: '/definitely/not/this/repo' },
      );
      assert.equal(recorded.statusCode, 200, recorded.body);
      const body = bodyOf(recorded);
      assert.equal(body.source, 'session');
      assert.equal(body.sessionId, 'session-init-viewed');
      assert.equal(body.workspace, await realpath(workspace.dir));
    } finally {
      await workspace.cleanup();
    }
  });
});
