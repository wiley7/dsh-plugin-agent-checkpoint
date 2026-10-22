/**
 * Session log discovery + context digest tests.
 *
 * Uses synthetic DSH session logs (both plain JSONL and zstd-compressed) so the
 * suite runs without a live DSH session and without touching the real `$DSH_HOME`.
 */

import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import * as zlib from 'node:zlib';

import { captureSessionContext, digestEvents, discoverSessionLog, readSessionHeader, scrubText, sessionIdsMatch } from '../session.js';
import { makeWorkspace, sampleSessionEvents, toJsonl, type TempWorkspace } from './helpers.js';

const LIMITS = { maxMessageChars: 200, maxMessages: 10, maxBytes: 64 * 1024 };

function compress(text: string): Buffer {
  const zstd = (zlib as unknown as { zstdCompressSync?: (input: Buffer) => Buffer }).zstdCompressSync;
  if (typeof zstd !== 'function') throw new Error('zstd support missing from this node build');
  return zstd(Buffer.from(text, 'utf8'));
}

async function writeSession(
  dshHome: string,
  bucket: string,
  sessionDir: string,
  jsonl: string,
  options: { zstd?: boolean } = {},
): Promise<string> {
  const dir = path.join(dshHome, 'sessions', bucket, sessionDir);
  await mkdir(dir, { recursive: true });
  if (options.zstd) {
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    await writeFile(file, compress(jsonl));
    return file;
  }
  const file = path.join(dir, 'session.v4.jsonl');
  await writeFile(file, jsonl, 'utf8');
  return file;
}

describe('session digest', () => {
  it('keeps user intent, assistant text, tool usage and the todo plan', () => {
    const events = sampleSessionEvents({ sessionId: 'session-abc', cwd: '/tmp/ws' });
    const digest = digestEvents(toJsonl(events).split('\n'), LIMITS);
    assert.equal(digest.messages.length, 2);
    assert.equal(digest.messages[0]!.role, 'user');
    assert.equal(digest.messages[0]!.text, 'Build the checkpoint plugin');
    assert.equal(digest.messages[1]!.role, 'assistant');
    assert.match(digest.messages[1]!.text, /scaffold the project/);
    assert.deepEqual(
      digest.toolUsage.map((entry) => [ entry.name, entry.calls ]),
      [ [ 'bash', 2 ] ],
    );
    assert.equal(digest.plan.length, 2);
    assert.equal(digest.plan[1]!.status, 'in_progress');
    // The 50 KB token stream must never be part of the digest.
    assert.ok(digest.messages.every((message) => message.text.length < 5000));
  });

  it('skips runtime-context and system-reminder messages', () => {
    const events = [
      { type: 'session', version: 4, id: 's', cwd: '/tmp/ws' },
      { type: 'user/message', data: { content: [ { type: 'text', text: 'real request' } ], source: { kind: 'user' } } },
      { type: 'user/message', data: { content: [ { type: 'text', text: 'injected' } ], source: { kind: 'time-context' } } },
      { type: 'user/message', data: { content: [ { type: 'text', text: '<system-reminder>noise</system-reminder>' } ], source: { kind: 'user' } } },
    ];
    const digest = digestEvents(toJsonl(events).split('\n'), LIMITS);
    assert.deepEqual(digest.messages.map((message) => message.text), [ 'real request' ]);
  });

  it('truncates oversized messages and strips base64 payloads', () => {
    const longText = `start ${Buffer.from('hello world'.repeat(40)).toString('base64')} ${'lorem ipsum dolor sit amet '.repeat(30)} end`;
    const events = [
      { type: 'session', version: 4, id: 's', cwd: '/tmp/ws' },
      { type: 'user/message', data: { content: [ { type: 'text', text: longText } ], source: { kind: 'user' } } },
    ];
    const digest = digestEvents(toJsonl(events).split('\n'), LIMITS);
    const message = digest.messages[0]!;
    assert.equal(message.truncated, true);
    assert.ok(message.text.length <= LIMITS.maxMessageChars + 1);
    assert.match(message.text, /skipped: base64/);
    assert.equal(digest.truncated, true);
  });

  it('scrubText leaves normal prose untouched', () => {
    const { text, truncated } = scrubText('Fix the retry logic in src/http.ts\n\nThanks', 200);
    assert.equal(text, 'Fix the retry logic in src/http.ts\n\nThanks');
    assert.equal(truncated, false);
  });

  it('counts unparseable records as warnings instead of failing', () => {
    const digest = digestEvents([ 'not json', '{"type":"user/message","data":{}}' ], LIMITS);
    assert.equal(digest.eventCount, 1);
    assert.match(digest.warnings.join(' '), /could not be parsed/);
  });
});

describe('session capture', () => {
  let workspace: TempWorkspace;

  before(async () => {
    workspace = await makeWorkspace('ckpt-session-');
  });

  after(async () => {
    await workspace.cleanup();
  });

  it('locates and digests a zstd-compressed session log for the workspace cwd', async () => {
    const jsonl = toJsonl(sampleSessionEvents({ sessionId: 'session-zstd', cwd: workspace.dir }));
    const file = await writeSession(workspace.dshHome, 'bucket-a', 'session-zstd', jsonl, { zstd: true });

    const header = await readSessionHeader(file);
    assert.equal(header?.id, 'session-zstd');
    assert.equal(header?.cwd, workspace.dir);
    assert.equal(header?.version, 4);

    const discovered = await discoverSessionLog({ workspacePath: workspace.dir, dshHome: workspace.dshHome });
    assert.equal(discovered.file, file);
    assert.equal(discovered.sessionId, 'session-zstd');

    const captured = await captureSessionContext({
      workspacePath: workspace.dir,
      dshHome: workspace.dshHome,
      limits: LIMITS,
    });
    assert.equal(captured.context.sessionId, 'session-zstd');
    assert.equal(captured.context.cwd, workspace.dir);
    assert.equal(captured.context.agentPreset, 'planner');
    assert.equal(captured.context.messageCount, 2);
    assert.equal(captured.context.plan.length, 2);
    assert.equal(captured.warnings.length, 0);
    assert.ok(captured.context.bytes > 0);
  });

  it('decodes a log appended in many zstd frames (the real DSH shape)', async () => {
    // DSH appends one zstd frame per flushed write, so `session.v4.jsonl.zstd` is
    // a concatenation of frames. node:zlib decodes only the first one, which used
    // to reduce a real log to its header record.
    const events = sampleSessionEvents({ sessionId: 'session-frames', cwd: workspace.dir });
    const frames = toJsonl(events)
      .split('\n')
      .map((line) => compress(`${line}\n`));
    const dir = path.join(workspace.dshHome, 'sessions', 'bucket-frames', 'session-frames');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, 'session.v4.jsonl.zstd');
    await writeFile(file, Buffer.concat(frames));

    const header = await readSessionHeader(file);
    assert.equal(header?.id, 'session-frames');

    const captured = await captureSessionContext({
      workspacePath: workspace.dir,
      sessionId: 'session-frames',
      dshHome: workspace.dshHome,
      limits: LIMITS,
    });
    assert.ok(captured.context.eventCount >= events.length, `expected every frame to decode, saw ${captured.context.eventCount} events`);
    assert.equal(captured.context.messageCount, 2);
    assert.equal(captured.context.plan.length, 2);
    assert.equal(captured.warnings.length, 0);
  });

  it('keeps the newest events when the read cap is hit', async () => {
    const events: Array<Record<string, unknown>> = [ { type: 'session', version: 4, id: 'session-tail', cwd: workspace.dir } ];
    for (let index = 0; index < 20; index += 1) {
      events.push({
        type: 'user/message',
        data: { content: [ { type: 'text', text: `turn ${index} ${'padding '.repeat(20)}` } ], source: { kind: 'user' } },
      });
    }
    await writeSession(workspace.dshHome, 'bucket-tail', 'session-tail', toJsonl(events), { zstd: true });

    const captured = await captureSessionContext({
      workspacePath: workspace.dir,
      sessionId: 'session-tail',
      dshHome: workspace.dshHome,
      limits: { ...LIMITS, maxReadBytes: 1200, maxMessages: 4 },
    });
    const texts = captured.context.messages.map((message) => message.text);
    assert.ok(texts.length > 0);
    assert.match(texts.at(-1)!, /turn 19/, 'the newest turn must survive the cap');
    assert.ok(texts.every((text) => !text.includes('turn 0 ')), 'the oldest turns must be dropped first');
    assert.equal(captured.context.truncated, true);
  });

  it('prefers the explicitly named session id even when another log is newer', async () => {
    const older = toJsonl(sampleSessionEvents({ sessionId: 'session-wanted', cwd: workspace.dir }));
    const wantedFile = await writeSession(workspace.dshHome, 'bucket-b', 'session-wanted', older, { zstd: true });
    const newer = toJsonl(sampleSessionEvents({ sessionId: 'session-other', cwd: '/somewhere/else' }));
    await writeSession(workspace.dshHome, 'bucket-b', 'session-other', newer);

    const discovered = await discoverSessionLog({
      workspacePath: workspace.dir,
      sessionId: 'session-wanted',
      dshHome: workspace.dshHome,
    });
    assert.equal(discovered.file, wantedFile);
  });

  it('finds a session by id when the directory is named after the id (real DSH layout)', async () => {
    const id = 'session-real-shape';
    const file = await writeSession(workspace.dshHome, 'bucket-real', id, toJsonl(sampleSessionEvents({ sessionId: id, cwd: workspace.dir })));

    const byFullId = await discoverSessionLog({ workspacePath: '', sessionId: id, dshHome: workspace.dshHome });
    assert.equal(byFullId.file, file, 'a session id equal to the directory name must match');

    // Callers may hold the id without its `session-` prefix; both forms name the
    // same log, and DSH itself writes ids with the prefix.
    const byBareId = await discoverSessionLog({ workspacePath: '', sessionId: 'real-shape', dshHome: workspace.dshHome });
    assert.equal(byBareId.file, file, 'a prefix-less id must match the prefixed directory');

    assert.equal(sessionIdsMatch(id, id), true);
    assert.equal(sessionIdsMatch(id, 'real-shape'), true);
    assert.equal(sessionIdsMatch('real-shape', id), true);
    assert.equal(sessionIdsMatch(null, id), false);
    assert.equal(sessionIdsMatch(id, ''), false);
    assert.equal(sessionIdsMatch(id, 'session-other'), false);
  });

  it('reports a warning and an empty context when nothing matches', async () => {
    const captured = await captureSessionContext({
      workspacePath: path.join(workspace.dir, 'missing-workspace'),
      dshHome: workspace.dshHome,
      limits: LIMITS,
    });
    assert.equal(captured.context.messageCount, 0);
    assert.equal(captured.context.sourceFile, null);
    assert.match(captured.warnings.join(' '), /no session log/);
  });

  it('enforces max_context_bytes by dropping the oldest messages', async () => {
    const events: Array<Record<string, unknown>> = [ { type: 'session', version: 4, id: 'session-big', cwd: workspace.dir } ];
    for (let index = 0; index < 30; index += 1) {
      events.push({
        type: 'user/message',
        data: { content: [ { type: 'text', text: `message ${index} ${'lorem ipsum dolor '.repeat(30)}` } ], source: { kind: 'user' } },
      });
    }
    await writeSession(workspace.dshHome, 'bucket-c', 'session-session-big', toJsonl(events), { zstd: true });

    const captured = await captureSessionContext({
      workspacePath: workspace.dir,
      sessionId: 'session-big',
      dshHome: workspace.dshHome,
      limits: { maxMessageChars: 600, maxMessages: 30, maxBytes: 4096 },
    });
    assert.equal(captured.context.truncated, true);
    assert.ok(captured.context.bytes <= 4096 || captured.context.messages.length === 0);
    assert.ok(captured.context.messages.length < 30);
  });
});
