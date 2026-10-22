/**
 * Attribution rules: which snapshot a reply is allowed to claim.
 *
 * These are the invariants the badge depends on, so they are asserted without a
 * git repository, a session log, or a browser: the projection only needs the
 * chronology and the checkpoint records.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attributeMessages, shortCheckpointId, turnIndexForTime, type CheckpointPoint } from '../attribution.js';
import type { SessionTimeline } from '../session.js';

/** Two turns: turn 1 at t=1000..2000, turn 2 at t=3000..4000. */
const TIMELINE: SessionTimeline = {
  sessionId: 'session-1',
  cwd: '/tmp/project',
  eventCount: 8,
  turns: [
    { turn: 1, startSeq: 1, startAt: 1000, endSeq: 5, endAt: 2000 },
    { turn: 2, startSeq: 6, startAt: 3000, endSeq: 9, endAt: 4000 },
  ],
  messages: [
    { messageId: 'msg-1', turn: 1, seq: 3, at: 1500 },
    { messageId: 'msg-2', turn: 2, seq: 8, at: 3500 },
  ],
};

/** One snapshot created just after turn 1 ended. */
const AFTER_TURN_ONE: CheckpointPoint = {
  id: 'ckpt-2500-aaaa1111',
  title: 'After turn one',
  status: 'draft',
  createdAt: 2500,
  commitHash: null,
};

/** One snapshot created just after turn 2 ended. */
const AFTER_TURN_TWO: CheckpointPoint = {
  id: 'ckpt-4500-bbbb2222',
  title: 'After turn two',
  status: 'confirmed',
  createdAt: 4500,
  commitHash: 'deadbeef',
};

describe('shortCheckpointId', () => {
  it('keeps the distinguishing suffix, not the timestamp', () => {
    assert.equal(shortCheckpointId('ckpt-1792582824171-fb62938a'), 'fb62938a');
    assert.equal(shortCheckpointId('draft-1792582824171-abcd'), 'abcd');
    assert.equal(shortCheckpointId('plainid'), 'plainid');
    assert.equal(shortCheckpointId(''), null);
    assert.equal(shortCheckpointId(null), null);
  });
});

describe('turnIndexForTime', () => {
  it('maps an instant onto the last turn that had started', () => {
    assert.equal(turnIndexForTime(TIMELINE.turns, 500), -1, 'before the first turn');
    assert.equal(turnIndexForTime(TIMELINE.turns, 1000), 0);
    assert.equal(turnIndexForTime(TIMELINE.turns, 2500), 0, 'a snapshot written after turn 1 still belongs to turn 1');
    assert.equal(turnIndexForTime(TIMELINE.turns, 3000), 1);
  });
});

describe('attributeMessages', () => {
  it('gives each reply the snapshot created in its own turn', () => {
    const [ first, second ] = attributeMessages(TIMELINE, [ AFTER_TURN_ONE, AFTER_TURN_TWO ]);
    assert.equal(first!.messageId, 'msg-1');
    assert.equal(first!.checkpointId, AFTER_TURN_ONE.id);
    assert.equal(first!.inherited, false);
    assert.equal(first!.short, 'aaaa1111');
    assert.equal(first!.fromTurn, 1);

    assert.equal(second!.messageId, 'msg-2');
    assert.equal(second!.checkpointId, AFTER_TURN_TWO.id);
    assert.equal(second!.status, 'confirmed');
    assert.equal(second!.commitHash, 'deadbeef');
    assert.equal(second!.inherited, false);
  });

  it('never lets a later snapshot rewrite an earlier reply', () => {
    // Turn 2 had not produced anything yet: the reply still shows turn 1's save.
    const [ first, second ] = attributeMessages(TIMELINE, [ AFTER_TURN_ONE ]);
    assert.equal(first!.checkpointId, AFTER_TURN_ONE.id);
    assert.equal(second!.checkpointId, AFTER_TURN_ONE.id);
    assert.equal(second!.inherited, true, 'the older snapshot was already in force');
    assert.equal(second!.fromTurn, 1);

    const onlyLater = attributeMessages(TIMELINE, [ AFTER_TURN_TWO ]);
    assert.equal(onlyLater[0]!.checkpointId, null, 'a reply written before any save shows nothing');
    assert.equal(onlyLater[0]!.short, null);
    assert.equal(onlyLater[1]!.checkpointId, AFTER_TURN_TWO.id);
  });

  it('reports nothing for a reply that predates every snapshot', () => {
    const [ first ] = attributeMessages(TIMELINE, [ AFTER_TURN_TWO ]);
    assert.deepEqual(
      { checkpointId: first!.checkpointId, title: first!.title, status: first!.status, hash: first!.commitHash, createdAt: first!.createdAt },
      { checkpointId: null, title: null, status: null, hash: null, createdAt: null },
    );
  });

  it('falls back to the clock when the log never opened a window for the turn', () => {
    const orphan: SessionTimeline = { ...TIMELINE, messages: [ { messageId: 'msg-orphan', turn: 99, seq: 12, at: 2500 } ] };
    const [ entry ] = attributeMessages(orphan, [ AFTER_TURN_ONE, AFTER_TURN_TWO ]);
    assert.equal(entry!.checkpointId, AFTER_TURN_ONE.id, 'the newer save came after this reply');
    assert.equal(entry!.inherited, true);
  });

  it('ignores records without a usable timestamp', () => {
    const broken = { ...AFTER_TURN_ONE, createdAt: Number.NaN };
    const entries = attributeMessages(TIMELINE, [ broken ]);
    assert.equal(entries[0]!.checkpointId, null);
  });
});
