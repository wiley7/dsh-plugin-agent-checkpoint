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
  MAX_COMMITS_LIMIT,
  ROUTE_PATH,
  apply,
  buildGitSnapshot,
  checkpointIndex,
  handleGitRequest,
  isLoopbackAddress,
  normalizeHostConfig,
  parseMaxCommits,
  resolveWorkspace,
} from '../host.js';
import { makeWorkspace, sampleSessionEvents, toJsonl, writeWorkspaceFile, type TempWorkspace } from './helpers.js';

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
  const dir = path.join(dshHome, 'sessions', '--tmp--', `session-${sessionId}`);
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

  it('registers one exact route through ctx.effect', () => {
    const registrations: Array<{ kind: string; path: string; handler?: unknown }> = [];
    let effects = 0;
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
      effect(run: () => () => void) {
        effects += 1;
        return run();
      },
    };
    apply(ctx as never, { workspace: workspace.dir });
    assert.equal(effects, 1);
    assert.equal(registrations.length, 1);
    assert.equal(registrations[0]?.kind, 'exact');
    assert.equal(registrations[0]?.path, ROUTE_PATH);
    assert.equal(disposed, 0);
  });
});
