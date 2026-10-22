/**
 * Trigger engine tests.
 *
 * These cover the decision table only — no git, no DSH: the engine's job is to
 * turn "a turn ended" into "save" / "skip because X", so every branch of that
 * call is asserted here, including the ones that exist to avoid surprising the
 * operator (nothing on a clean tree in `file_change` mode, nothing twice in one
 * turn, nothing when the session names no project).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPolicyState, type AutoPolicy } from '../policy.js';
import {
  automaticRemark,
  automaticTags,
  automaticTitle,
  createTriggerEngine,
  type SessionEventSource,
  type TriggerDeps,
  type TriggerOutcome,
} from '../trigger.js';

/** Build a deps record with sane, overridable defaults and call counters. */
function fakeDeps(overrides: Omit<Partial<TriggerDeps>, 'policy'> & { policy?: Partial<AutoPolicy> } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  const counters = { workspaceFor: 0, isRepository: 0, isDirty: 0 };
  const { policy: policyOverrides, ...rest } = overrides;
  const deps: TriggerDeps = {
    policy: (): AutoPolicy => ({
      trigger: 'off',
      apply: 'draft',
      interval_turns: 5,
      ...policyOverrides,
    }),
    workspaceFor: async () => {
      counters.workspaceFor += 1;
      return '/repo';
    },
    isRepository: async () => {
      counters.isRepository += 1;
      return true;
    },
    isDirty: async () => {
      counters.isDirty += 1;
      return true;
    },
    takeCheckpoint: async (request) => {
      calls.push(request as unknown as Record<string, unknown>);
      return { checkpointId: 'draft-1792582824171-abcd1234', status: 'draft' };
    },
    log: (message) => logs.push(message),
    ...rest,
  };
  return { deps, calls, logs, counters };
}

/** A `turn/end` event. */
const end = (turn: number) => ({ type: 'turn/end', data: { turn, reason: 'stop' } });

describe('trigger engine decisions', () => {
  it('ignores everything but turn boundaries', async () => {
    const { deps, calls, counters } = fakeDeps({ policy: { trigger: 'turn' } });
    const engine = createTriggerEngine(deps);
    for (const type of [ 'user/message', 'assistant/message', 'tool/call', 'workspace/changes', 'turn/start' ]) {
      const outcome = await engine.handle({ id: 's1' }, { type });
      assert.deepEqual(outcome, { fired: false, reason: 'not_a_turn_end', turn: null });
    }
    assert.equal(calls.length, 0);
    assert.equal(counters.workspaceFor, 0);
  });

  it('calls nothing when the operator left the trigger off', async () => {
    const { deps, calls, counters } = fakeDeps();
    const engine = createTriggerEngine(deps);
    const outcome = await engine.handle({ id: 's1' }, end(1));
    assert.deepEqual(outcome, { fired: false, reason: 'trigger_off', turn: 1 });
    assert.equal(calls.length, 0);
    // The workspace is resolved before the policy is judged: a project preset
    // stored in that directory may override the profile-wide default.
    assert.equal(counters.workspaceFor, 1);
    assert.equal(engine.state('s1')?.turns, 1);
  });

  it('saves every turn in "turn" mode, even without file changes', async () => {
    const { deps, calls, counters } = fakeDeps({ policy: { trigger: 'turn' }, isDirty: async () => false });
    const engine = createTriggerEngine(deps);
    const outcome = await engine.handle({ id: 's1' }, end(2));
    assert.equal(outcome.fired, true);
    assert.deepEqual(calls[0], {
      workspace: '/repo',
      sessionId: 's1',
      turn: 2,
      title: 'Automatic checkpoint · turn 2',
      remark: 'Saved automatically after turn 2: every turn saves in this mode.',
      tags: [ 'auto', 'turn' ],
      trigger: 'turn',
      apply: 'draft',
    });
    // `turn` mode is the one mode that must not ask git whether the tree is clean.
    assert.equal(counters.isDirty, 0);
    assert.equal(engine.state('s1')?.fired, 1);
    assert.equal(engine.state('s1')?.lastFiredTurn, 2);
  });

  it('skips a clean tree in "file_change" mode', async () => {
    const { deps, calls } = fakeDeps({ policy: { trigger: 'file_change' }, isDirty: async () => false });
    const engine = createTriggerEngine(deps);
    const outcome = await engine.handle({ id: 's1' }, end(1));
    assert.deepEqual(outcome, { fired: false, reason: 'no_changes', turn: 1 });
    assert.equal(calls.length, 0);
  });

  it('saves a dirty tree in "file_change" mode', async () => {
    const { deps, calls } = fakeDeps({ policy: { trigger: 'file_change', apply: 'commit' } });
    const engine = createTriggerEngine(deps);
    const outcome = await engine.handle({ id: 's1' }, end(1));
    assert.equal(outcome.fired, true);
    assert.equal(calls[0]?.trigger, 'file_change');
    // `apply` is the policy's decision; the host half performs the commit.
    assert.equal(calls[0]?.apply, 'commit');
    assert.deepEqual(calls[0]?.tags, [ 'auto', 'file_change' ]);
  });

  it('fires only on interval multiples in "interval_turns" mode', async () => {
    const { deps, calls } = fakeDeps({ policy: { trigger: 'interval_turns', interval_turns: 3 } });
    const engine = createTriggerEngine(deps);
    const outcomes: TriggerOutcome[] = [];
    for (const turn of [ 1, 2, 3, 4, 5, 6 ]) outcomes.push(await engine.handle({ id: 's1' }, end(turn)));
    assert.deepEqual(
      outcomes.map((outcome) => (outcome.fired ? 'fired' : outcome.reason)),
      [ 'not_due', 'not_due', 'fired', 'not_due', 'not_due', 'fired' ],
    );
    assert.deepEqual(calls.map((call) => call.turn), [ 3, 6 ]);
    assert.match(String(calls[0]?.remark), /every 3 turns/);
  });

  it('never saves the same turn twice', async () => {
    const { deps, calls } = fakeDeps({ policy: { trigger: 'turn' } });
    const engine = createTriggerEngine(deps);
    assert.equal((await engine.handle({ id: 's1' }, end(4))).fired, true);
    const second = await engine.handle({ id: 's1' }, end(4));
    assert.deepEqual(second, { fired: false, reason: 'already_fired', turn: 4 });
    assert.equal(calls.length, 1);
  });

  it('skips a session that names no workspace', async () => {
    const { deps, counters } = fakeDeps({ policy: { trigger: 'turn' }, workspaceFor: async () => null });
    const engine = createTriggerEngine(deps);
    assert.deepEqual(await engine.handle({ id: 's1' }, end(1)), { fired: false, reason: 'no_workspace', turn: 1 });
    assert.equal(counters.isRepository, 0);
  });

  it('skips a directory that is not a repository root', async () => {
    const { deps, calls } = fakeDeps({ policy: { trigger: 'turn' }, isRepository: async () => false });
    const engine = createTriggerEngine(deps);
    assert.deepEqual(await engine.handle({ id: 's1' }, end(1)), { fired: false, reason: 'not_a_repository', turn: 1 });
    assert.equal(calls.length, 0);
  });

  it('reports a failed capture without throwing, and retries the next turn', async () => {
    let attempts = 0;
    const { deps, logs } = fakeDeps({
      policy: { trigger: 'turn' },
      takeCheckpoint: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('nothing_to_checkpoint');
        return { checkpointId: 'draft-1792582824171-abcd1234', status: 'draft' };
      },
    });
    const engine = createTriggerEngine(deps);
    const failed = await engine.handle({ id: 's1' }, end(1));
    assert.deepEqual(failed, { fired: false, reason: 'failed', turn: 1, message: 'nothing_to_checkpoint' });
    assert.match(logs.join('\n'), /skipped after turn 1 \(nothing_to_checkpoint\)/);
    assert.equal(engine.state('s1')?.lastFiredTurn, null);
    // A failure must not poison the session: the next turn tries again.
    assert.equal((await engine.handle({ id: 's1' }, end(2))).fired, true);
  });

  it('keeps sessions independent', async () => {
    const { deps } = fakeDeps({ policy: { trigger: 'turn' } });
    const engine = createTriggerEngine(deps);
    assert.equal((await engine.handle({ id: 'a' }, end(1))).fired, true);
    // Same turn number, different session: not `already_fired`.
    assert.equal((await engine.handle({ id: 'b' }, end(1))).fired, true);
    assert.equal(engine.state('a')?.fired, 1);
    assert.equal(engine.state('b')?.fired, 1);
  });
});

describe('trigger engine lifecycle', () => {
  it('serialises evaluations of one session', async () => {
    const order: string[] = [];
    const { deps } = fakeDeps({
      policy: { trigger: 'turn' },
      takeCheckpoint: async (request) => {
        order.push(`start:${String(request.turn)}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`end:${String(request.turn)}`);
        return { checkpointId: 'draft-1792582824171-abcd1234', status: 'draft' };
      },
    });
    const engine = createTriggerEngine(deps);
    await Promise.all([ engine.handle({ id: 's1' }, end(1)), engine.handle({ id: 's1' }, end(2)) ]);
    assert.deepEqual(order, [ 'start:1', 'end:1', 'start:2', 'end:2' ]);
  });

  it('forgets a session when it is disposed, and on reset()', async () => {
    const { deps } = fakeDeps({ policy: { trigger: 'turn' } });
    const engine = createTriggerEngine(deps);
    await engine.handle({ id: 's1' }, end(1));
    assert.equal(engine.state('s1')?.turns, 1);
    await engine.handle({ id: 's1' }, { type: 'session/disposed' });
    assert.equal(engine.state('s1'), undefined);
    await engine.handle({ id: 's2' }, end(1));
    engine.reset();
    assert.equal(engine.state('s2'), undefined);
  });

  it('returns a copy so callers cannot mutate bookkeeping', async () => {
    const { deps } = fakeDeps({ policy: { trigger: 'turn' } });
    const engine = createTriggerEngine(deps);
    await engine.handle({ id: 's1' }, end(1));
    const snapshot = engine.state('s1');
    assert.ok(snapshot);
    snapshot.turns = 99;
    assert.equal(engine.state('s1')?.turns, 1);
  });

  it('subscribes to session events and swallows failures', async () => {
    const { deps } = fakeDeps({
      policy: { trigger: 'turn' },
      takeCheckpoint: async () => {
        throw new Error('boom');
      },
    });
    const engine = createTriggerEngine(deps);
    const listeners: Array<(session: { id: string }, event: { type: string; data?: unknown }) => void> = [];
    const source: SessionEventSource = {
      on: (event, listener) => {
        assert.equal(event, 'session/event');
        listeners.push(listener);
        return () => undefined;
      },
    };
    engine.observe(source);
    assert.equal(listeners.length, 1);
    // Must not reject: a failed snapshot may never break the host's turn loop.
    assert.doesNotThrow(() => listeners[0]?.({ id: 's1' }, end(1)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(engine.state('s1')?.turns, 1);
  });

  it('observes nothing when the host has no event bus', () => {
    const { deps } = fakeDeps();
    const engine = createTriggerEngine(deps);
    assert.doesNotThrow(() => engine.observe({} as SessionEventSource));
  });
});

describe('trigger labels', () => {
  it('names snapshots so they are recognisable in the list', () => {
    assert.equal(automaticTitle(7), 'Automatic checkpoint · turn 7');
    assert.equal(automaticTitle(null), 'Automatic checkpoint');
    const policy = createPolicyState({ trigger: 'file_change' }).get();
    assert.match(automaticRemark(policy, 3), /after turn 3: the turn changed files/);
    assert.match(automaticRemark(policy, null), /Saved automatically after a turn/);
    assert.deepEqual(automaticTags(policy), [ 'auto', 'file_change' ]);
  });
});
