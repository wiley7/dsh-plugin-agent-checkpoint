/**
 * Policy tests: the `agent-checkpoint` settings namespace.
 *
 * The namespace is the only thing the settings card edits, so these tests pin
 * the parts that decide behaviour: conservative defaults, tolerant parsing of a
 * hand-edited document, clamping, and the fact that registration degrades
 * silently when the host has no settings service.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_AUTO_POLICY,
  INTERVAL_TURNS_MAX,
  INTERVAL_TURNS_MIN,
  POLICY_APPLIES,
  POLICY_NAMESPACE,
  POLICY_TRIGGERS,
  createFallbackPolicySchema,
  createPolicySchema,
  createPolicyState,
  installPolicySettings,
  isPolicyApply,
  isPolicyTrigger,
  normalizeAutoPolicy,
  type SettingsScopeLike,
} from '../policy.js';

describe('policy value', () => {
  it('defaults to off + draft so turning the feature on never writes history', () => {
    assert.equal(DEFAULT_AUTO_POLICY.trigger, 'off');
    assert.equal(DEFAULT_AUTO_POLICY.apply, 'draft');
    assert.deepEqual(normalizeAutoPolicy(undefined), DEFAULT_AUTO_POLICY);
    assert.deepEqual(normalizeAutoPolicy(null), DEFAULT_AUTO_POLICY);
    assert.deepEqual(normalizeAutoPolicy('nonsense'), DEFAULT_AUTO_POLICY);
  });

  it('recognises exactly the documented ids', () => {
    for (const id of POLICY_TRIGGERS) assert.equal(isPolicyTrigger(id), true, id);
    for (const id of POLICY_APPLIES) assert.equal(isPolicyApply(id), true, id);
    for (const id of [ 'sometimes', '', 'OFF', 1, null ]) {
      assert.equal(isPolicyTrigger(id), false, String(id));
      assert.equal(isPolicyApply(id), false, String(id));
    }
  });

  it('keeps a valid section and clamps the interval', () => {
    assert.deepEqual(normalizeAutoPolicy({ trigger: 'file_change', apply: 'commit', interval_turns: 3 }), {
      trigger: 'file_change',
      apply: 'commit',
      interval_turns: 3,
    });
    assert.equal(normalizeAutoPolicy({ interval_turns: 0 }).interval_turns, INTERVAL_TURNS_MIN);
    assert.equal(normalizeAutoPolicy({ interval_turns: -4 }).interval_turns, INTERVAL_TURNS_MIN);
    assert.equal(normalizeAutoPolicy({ interval_turns: 9_000 }).interval_turns, INTERVAL_TURNS_MAX);
    assert.equal(normalizeAutoPolicy({ interval_turns: 2.6 }).interval_turns, 3);
    assert.equal(normalizeAutoPolicy({ interval_turns: Number.NaN }).interval_turns, DEFAULT_AUTO_POLICY.interval_turns);
    assert.equal(normalizeAutoPolicy({ interval_turns: '7' }).interval_turns, DEFAULT_AUTO_POLICY.interval_turns);
  });

  it('replaces only the fields that are wrong', () => {
    const policy = normalizeAutoPolicy({ trigger: 'turn', apply: 'sideways', interval_turns: 8 });
    assert.deepEqual(policy, { trigger: 'turn', apply: DEFAULT_AUTO_POLICY.apply, interval_turns: 8 });
  });
});

describe('policy state', () => {
  it('reports where the value came from', () => {
    const state = createPolicyState();
    assert.equal(state.source(), 'defaults');
    assert.equal(state.get().trigger, 'off');
    state.adopt({ trigger: 'turn' });
    assert.equal(state.source(), 'settings');
    assert.equal(state.get().trigger, 'turn');
  });

  it('starts as settings-sourced when a value is supplied', () => {
    const state = createPolicyState({ trigger: 'file_change' });
    assert.equal(state.source(), 'settings');
    assert.equal(state.get().trigger, 'file_change');
  });
});

describe('policy schema', () => {
  it('always produces a schema the settings service can resolve and serialize', () => {
    const { schema, builder } = createPolicySchema();
    assert.ok(builder === 'schemastery' || builder === 'fallback');
    assert.equal(typeof schema, 'function');
    assert.deepEqual(normalizeAutoPolicy(schema({})), DEFAULT_AUTO_POLICY);
    assert.equal(typeof schema.toJSON(), 'object');
  });

  it('the hand-written fallback resolves and serializes on its own', () => {
    const schema = createFallbackPolicySchema();
    assert.deepEqual(schema({ trigger: 'turn', apply: 'commit', interval_turns: 2 }), {
      trigger: 'turn',
      apply: 'commit',
      interval_turns: 2,
    });
    const described = schema.toJSON() as { uid: number; refs: Record<string, { dict?: Record<string, number> }> };
    assert.equal(typeof described.uid, 'number');
    assert.deepEqual(Object.keys(described.refs[described.uid]?.dict ?? {}).sort(), [ 'apply', 'interval_turns', 'trigger' ]);
  });
});

describe('installPolicySettings', () => {
  /** A settings service stand-in that records registrations and can notify watchers. */
  function fakeSettings() {
    const registrations: Array<{ namespace: string; schema: (value: unknown) => unknown; base: unknown }> = [];
    const watchers: Array<(next: unknown, previous: unknown) => void | Promise<void>> = [];
    let value: unknown = {};
    const scope: SettingsScopeLike = {
      get: () => value,
      watch: (callback) => {
        watchers.push(callback);
        return () => {
          const index = watchers.indexOf(callback);
          if (index >= 0) watchers.splice(index, 1);
        };
      },
    };
    return {
      registrations,
      scope,
      service: {
        register(namespace: string, schema: (value: unknown) => unknown, options?: { base?: unknown }) {
          registrations.push({ namespace, schema, base: options?.base });
          return scope;
        },
      },
      push(next: unknown) {
        value = next;
        for (const watcher of watchers) void watcher(next, value);
      },
    };
  }

  it('registers the documented namespace and follows its value', () => {
    const fake = fakeSettings();
    const state = createPolicyState();
    const logs: string[] = [];
    let requested: string[] = [];
    const installation = installPolicySettings(
      {
        inject: (dependencies, callback) => {
          requested = dependencies;
          callback({ settings: fake.service });
        },
      },
      state,
      { log: (message) => logs.push(message) },
    );

    assert.deepEqual(requested, [ 'settings' ]);
    assert.equal(installation.registered, true);
    assert.equal(fake.registrations.length, 1);
    assert.equal(fake.registrations[0]?.namespace, POLICY_NAMESPACE);
    assert.deepEqual(fake.registrations[0]?.base, DEFAULT_AUTO_POLICY);
    assert.equal(state.get().trigger, 'off');
    assert.match(logs.join('\n'), /registered settings namespace "agent-checkpoint"/);

    // The card writes through the settings service; the trigger engine must see it.
    fake.push({ trigger: 'interval_turns', apply: 'commit', interval_turns: 2 });
    assert.equal(state.get().trigger, 'interval_turns');
    assert.equal(state.get().apply, 'commit');
    assert.equal(state.get().interval_turns, 2);
  });

  it('degrades silently when the host has no settings service', () => {
    const state = createPolicyState();
    const logs: string[] = [];
    const withoutInject = installPolicySettings({}, state, { log: (message) => logs.push(message) });
    assert.deepEqual(withoutInject, { registered: false, schema: 'none' });

    const withoutService = installPolicySettings({ inject: (_deps, callback) => callback({}) }, state, {
      log: (message) => logs.push(message),
    });
    assert.equal(withoutService.registered, false);
    assert.equal(state.get().trigger, 'off');
    assert.deepEqual(logs, []);
  });

  it('reports a registration failure instead of throwing at startup', () => {
    const logs: string[] = [];
    const state = createPolicyState();
    const installation = installPolicySettings(
      {
        inject: (_deps, callback) =>
          callback({
            settings: {
              register() {
                throw new Error('settings namespace "agent-checkpoint" is already registered');
              },
            },
          }),
      },
      state,
      { log: (message) => logs.push(message) },
    );
    assert.equal(installation.registered, false);
    assert.match(logs.join('\n'), /already registered/);
    assert.equal(state.get().trigger, 'off');
  });
});
