/**
 * Browser-half tests: load `client/client.js` the way the DSH web frontend does
 * (a `window.__ModuleLoader__.load` bundle) inside a `node:vm` sandbox with a
 * tiny React shim, then exercise the pure display model and the slot wiring.
 *
 * No DOM, no bundler, no jsdom: the bundle only needs `require("react")` at load
 * time, so a fake module registry is enough to prove the badge renders and that
 * the registration lands on `conversation.chat.assistant-actions`.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import vm from 'node:vm';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.resolve(HERE, '..', '..', 'client', 'client.js');

interface Element {
  type: string;
  props: Record<string, unknown>;
  children: unknown[];
  key?: string;
}

interface FakeReact {
  createElement: (type: string, props: Record<string, unknown> | null, ...children: unknown[]) => Element;
  useState: (initial: unknown) => [unknown, (value: unknown) => void];
  useEffect: (effect: () => unknown) => void;
  useRef: (initial: unknown) => { current: unknown };
  useCallback: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown;
  useMemo: (fn: () => unknown) => unknown;
}

/** Snapshot returned by the fake route, shaped like the host half's response. */
const SNAPSHOT = {
  ok: true,
  workspace: '/tmp/project',
  source: 'session',
  sessionId: 'session-abc',
  isRepo: true,
  branch: 'main',
  head: {
    hash: 'a1b2c3d4e5f6a7b8c9d0',
    short: 'a1b2c3d',
    subject: 'feat: show the commit under every reply',
    committedAt: '2026-10-21T11:22:33.000Z',
    committedAtMs: 1_700_000_000_000,
    checkpoint: { id: 'ckpt-1700000000000-abcd1234', title: 'Release candidate', tags: [] },
  },
  isDirty: true,
  commits: [],
  capturedAt: '2026-10-21T11:22:44.000Z',
  error: null,
  warnings: [],
};

/** Build a React shim; `state` seeds every `useState` return value. */
function fakeReact(state?: unknown): FakeReact {
  return {
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(),
    }),
    useState: (initial) => [ state !== undefined ? state : typeof initial === 'function' ? (initial as () => unknown)() : initial, () => {} ],
    useEffect: () => {},
    useRef: (initial) => ({ current: initial }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  };
}

interface Bundle {
  id: string;
  exports: Record<string, any>;
  fetches: string[];
  requests: Array<{ url: string; method: string }>;
}

/** Load the browser bundle inside a vm sandbox. */
async function loadBundle(options: { state?: unknown; response?: unknown; initResponse?: { status: number; body: unknown } } = {}): Promise<Bundle> {
  const code = await readFile(BUNDLE, 'utf8');
  const meta: { id?: string; factory?: (require: (id: string) => unknown) => unknown } = {};
  const fetches: string[] = [];
  const requests: Array<{ url: string; method: string }> = [];
  const sandbox: Record<string, unknown> = {
    window: {
      __ModuleLoader__: {
        load(entry: { id: string; factory: (require: (id: string) => unknown) => unknown }) {
          Object.assign(meta, entry);
        },
      },
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    JSON,
    String,
    Number,
    Math,
    Map,
    Set,
    Promise,
    Object,
    Array,
    Error,
    encodeURIComponent,
    decodeURIComponent,
    URLSearchParams,
    Symbol,
    fetch: async (url: string, init?: { method?: string }) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      fetches.push(url);
      requests.push({ url, method });
      const isInit = url.includes('/agent-checkpoint/init');
      if (isInit && method === 'POST' && options.initResponse !== undefined) {
        return { ok: false, status: options.initResponse.status, json: async () => options.initResponse!.body };
      }
      if (isInit && method === 'POST') {
        return { ok: true, status: 200, json: async () => options.initResponse?.body ?? { ok: true, workspace: '/tmp/plain' } };
      }
      return { ok: true, status: 200, json: async () => options.response ?? SNAPSHOT };
    },
  };
  vm.runInNewContext(code, sandbox, { filename: 'client.js' });

  assert.equal(typeof meta.factory, 'function', 'bundle must call window.__ModuleLoader__.load with a factory');
  const react = fakeReact(options.state);
  const exports = (meta.factory as (require: (id: string) => unknown) => Record<string, any>)((id: string) => {
    if (id === 'react') return react;
    throw new Error(`unexpected require("${id}") in the client bundle`);
  });
  return { id: String(meta.id), exports, fetches, requests };
}

describe('client bundle contract', () => {
  it('declares the package id, injects the slots and locale services', async () => {
    const bundle = await loadBundle();
    assert.equal(bundle.id, 'dsh-plugin-agent-checkpoint');
    // The bundle runs in the sandbox realm, so copy before deep-comparing.
    assert.deepEqual([ ...bundle.exports.inject ], [ 'slots', 'locale' ]);
    assert.equal(typeof bundle.exports.apply, 'function');
  });

  it('registers one badge in the assistant action strip of every finalized reply', async () => {
    const bundle = await loadBundle();
    const slotCalls: Array<{ name: string; entry: Record<string, unknown> }> = [];
    const dictionaries: string[] = [];
    let effects = 0;

    const requested: string[][] = [];
    const bound: Array<{ namespace: string }> = [];
    const ctx = {
      locale: {
        register(namespace: string) {
          dictionaries.push(namespace);
          return () => {};
        },
      },
      slots: {
        inject(name: string, run: () => unknown) {
          slotCalls.push({ name, entry: run() as Record<string, unknown> });
        },
        register(options: Record<string, unknown>) {
          return options;
        },
      },
      inject(dependencies: string[], callback: (scoped: unknown) => void) {
        requested.push(dependencies);
        callback({
          ...ctx,
          settingsScope: {
            bind(options: { namespace: string }) {
              bound.push(options);
              return {
                getSnapshot: () => ({ status: 'ready', writable: true, value: { trigger: 'off', apply: 'draft', interval_turns: 5 } }),
                subscribe: () => () => {},
                set: () => Promise.resolve(),
              };
            },
          },
        });
      },
      effect(run: () => () => void) {
        effects += 1;
        return run();
      },
    };
    bundle.exports.apply(ctx);

    assert.equal(effects, 2);
    // The bundle runs in its own realm, so compare across realms by JSON.
    assert.equal(JSON.stringify(requested), JSON.stringify([ [ 'settingsScope' ] ]));
    assert.equal(JSON.stringify(bound), JSON.stringify([ { namespace: 'agent-checkpoint' } ]));
    assert.deepEqual(dictionaries, [ 'agent-checkpoint' ]);
    assert.equal(slotCalls.length, 2);
    const card = slotCalls[1]!;
    assert.equal(card.name, 'settings.plugin.item');
    assert.equal(card.entry.name, 'settings.plugin.item');
    assert.equal(card.entry.key, 'agent-checkpoint');
    assert.equal(card.entry.locale, 'agent-checkpoint');
    const cardFace = (card.entry.inject as () => Record<string, unknown>)();
    assert.deepEqual(Object.keys(cardFace), [ 'hooks' ]);
    assert.ok((cardFace.hooks as Record<string, unknown>).checkpointPolicy);

    const call = slotCalls[0]!;
    assert.equal(call.name, 'conversation.chat.assistant-actions');
    assert.equal(call.entry.name, 'conversation.chat.assistant-actions');
    assert.equal(call.entry.id, 'agent-checkpoint-commit');
    assert.equal(call.entry.order, 60);
    assert.equal(call.entry.locale, 'agent-checkpoint');
    const inject = call.entry.inject as (sessionId: string) => Record<string, unknown>;
    const face = inject('session-abc');
    assert.equal(face.sessionId, 'session-abc');
    assert.equal(Object.keys(face).length, 1);
  });
});

describe('client display model', () => {
  it('builds a session-scoped, cache-busted-free request URL', async () => {
    const bundle = await loadBundle();
    assert.equal(bundle.exports.badgeUrl('session-abc'), '/api/agent-checkpoint/git?session=session-abc&limit=50');
    assert.equal(bundle.exports.badgeUrl('a b/c'), '/api/agent-checkpoint/git?session=a+b%2Fc&limit=50');
  });

  it('rejects responses that are not a repository snapshot', async () => {
    const bundle = await loadBundle();
    const { normalizeSnapshot } = bundle.exports;
    assert.ok(normalizeSnapshot(SNAPSHOT));
    assert.equal(normalizeSnapshot(null), null);
    assert.equal(normalizeSnapshot({ ok: true, isRepo: false }), null);
    assert.equal(normalizeSnapshot({ ok: false, isRepo: true, head: { hash: 'x' } }), null);
    assert.equal(normalizeSnapshot({ ok: true, isRepo: true, head: { hash: '' } }), null);
  });

  it('turns a snapshot into the badge model', async () => {
    const bundle = await loadBundle();
    const model = bundle.exports.describeCommit(SNAPSHOT);
    assert.equal(model.short, 'a1b2c3d');
    assert.equal(model.label, 'a1b2c3d*');
    assert.equal(model.dirty, true);
    assert.equal(model.branch, 'main');
    assert.equal(model.checkpoint.id, 'ckpt-1700000000000-abcd1234');
    assert.match(model.title, /^main$/m);
    assert.match(model.title, /a1b2c3d4e5f6a7b8c9d0/);
    assert.match(model.title, /2026-10-21T11:22:33\.000Z/);
    assert.match(model.title, /feat: show the commit under every reply/);
    assert.match(model.title, /workspace has uncommitted changes/);
    assert.match(model.title, /checkpoint: ckpt-1700000000000-abcd1234 — Release candidate/);
    assert.match(model.title, /workspace: \/tmp\/project/);
    assert.equal(bundle.exports.describeCommit({ ok: true, isRepo: true, head: null }), null);
  });

  it('renders nothing when the workspace is not a repository', async () => {
    const bundle = await loadBundle();
    const element = bundle.exports.CommitBadge({ sessionId: 'session-abc', t: (key: string) => key });
    assert.equal(element, null);
  });

  it('renders branch, short hash, dirty marker and checkpoint flag', async () => {
    const bundle = await loadBundle({ state: { snapshot: SNAPSHOT, body: SNAPSHOT } });
    const element = bundle.exports.CommitBadge({
      sessionId: 'session-abc',
      t: (key: string) => key,
    }) as Element;
    assert.ok(element, 'badge should render');
    assert.equal(element.type, 'button');
    assert.equal(element.props['data-agent-checkpoint-commit'], 'a1b2c3d');
    assert.equal(element.props.type, 'button');
    const texts = element.children.map((child) => (typeof child === 'string' ? child : (child as Element).children.join('')));
    assert.ok(texts.some((text) => text.includes('main')), 'branch should render');
    assert.ok(texts.some((text) => text.includes('a1b2c3d')), 'short hash should render');
    assert.ok(texts.some((text) => text.includes('*')), 'dirty marker should render');
    assert.ok(texts.some((text) => text.includes('⚑')), 'checkpoint flag should render');
  });
});

describe('client init control', () => {
  /** Route body for a project that has no repository yet. */
  const NO_REPO = { ok: false, workspace: '/tmp/plain', source: 'session', sessionId: 'session-abc', isRepo: false, branch: null, head: null, isDirty: false, commits: [], capturedAt: '2026-10-21T11:22:44.000Z', error: 'not_a_git_repo', warnings: [] };

  it('offers to initialise a project that is not a repository yet', async () => {
    const bundle = await loadBundle();
    const view = bundle.exports.describeWorkspace(NO_REPO);
    assert.equal(view.kind, 'init');
    assert.equal(view.workspace, '/tmp/plain');
    assert.equal(bundle.exports.describeWorkspace(SNAPSHOT).kind, 'commit');
    assert.equal(bundle.exports.describeWorkspace(null).kind, 'none');
  });

  it('never offers to initialise a directory DSH merely fell back to', async () => {
    const bundle = await loadBundle();
    // `source: 'cwd'` means the session log named no project: that directory is
    // DSH's own launch folder, and writing into it would be a surprise.
    assert.equal(bundle.exports.describeWorkspace({ ...NO_REPO, source: 'cwd' }).kind, 'none');
    assert.equal(bundle.exports.describeWorkspace({ ok: false, error: 'invalid_workspace', source: 'session', workspace: '/tmp/x' }).kind, 'none');
    assert.equal(bundle.exports.describeWorkspace({ ...NO_REPO, workspace: '' }).kind, 'none');
  });

  it('posts the confirmation flag and refreshes once the project is ready', async () => {
    const bundle = await loadBundle({ response: NO_REPO });
    const store = bundle.exports.createStore();
    await store.refresh('session-abc');
    assert.equal(store.peek('session-abc'), null);

    // The second click: one POST that the host half only acts on with confirm=1.
    assert.equal(bundle.exports.initUrl('session-abc'), '/api/agent-checkpoint/init?session=session-abc&confirm=1');

    const ok = await store.initialize('session-abc');
    assert.equal(ok.ok, true);
    const posts = bundle.fetches.filter((url: string) => url.includes('/init'));
    assert.deepEqual(posts, [ '/api/agent-checkpoint/init?session=session-abc&confirm=1' ]);
    assert.equal(bundle.requests.some((request) => request.method === 'POST'), true);
  });

  it('surfaces a refused initialisation as an error and keeps the badge empty', async () => {
    const bundle = await loadBundle({ response: NO_REPO, initResponse: { status: 409, body: { ok: false, error: 'workspace_not_repository_root', message: 'this folder lives inside another repository' } } });
    const store = bundle.exports.createStore();
    await assert.rejects(() => store.initialize('session-abc'), /lives inside another repository/);
    assert.equal(store.error('session-abc'), 'this folder lives inside another repository');
    assert.equal(store.peek('session-abc'), null);
  });
});

describe('client store', () => {
  it('dedupes concurrent refreshes and reuses a fresh snapshot', async () => {
    const bundle = await loadBundle();
    const store = bundle.exports.createStore();
    const seen: unknown[] = [];
    const unsubscribe = store.subscribe('session-abc', (snapshot: unknown) => seen.push(snapshot));
    await store.refresh('session-abc');
    assert.equal(bundle.fetches.length, 1);
    assert.equal(seen.length, 1, 'subscriber receives the snapshot once');
    assert.equal((seen[0] as Record<string, unknown>).branch, 'main');

    await store.refresh('session-abc');
    assert.equal(bundle.fetches.length, 1, 'cached snapshot suppresses the second request');

    await store.refresh('session-abc', true);
    assert.equal(bundle.fetches.length, 2, 'force bypasses the cache');
    unsubscribe();
  });

  it('remembers a non-repository workspace as "nothing to show"', async () => {
    const bundle = await loadBundle({ response: { ok: false, isRepo: false, error: 'not_a_git_repo' } });
    const store = bundle.exports.createStore();
    await store.refresh('session-plain');
    assert.equal(store.peek('session-plain'), null);
    assert.equal(store.error('session-plain'), 'not_a_git_repo');
  });
});

describe('client settings card', () => {
  /** Flatten every string rendered under an element, in document order. */
  function collectText(node: unknown, out: string[] = []): string[] {
    if (typeof node === 'string') {
      out.push(node);
      return out;
    }
    if (Array.isArray(node)) {
      for (const child of node) collectText(child, out);
      return out;
    }
    if (node && typeof node === 'object') {
      const element = node as Element;
      collectText(element.children, out);
    }
    return out;
  }

  /** Every element whose props carry `data-agent-checkpoint-choice`. */
  function choices(node: unknown, out: Array<{ id: unknown; active: unknown; disabled: unknown }> = []) {
    if (Array.isArray(node)) {
      for (const child of node) choices(child, out);
      return out;
    }
    if (node && typeof node === 'object') {
      const element = node as Element;
      const id = element.props['data-agent-checkpoint-choice'];
      if (id !== undefined) out.push({ id, active: element.props['data-active'], disabled: element.props.disabled });
      choices(element.children, out);
    }
    return out;
  }

  it('normalizes persisted values onto the documented contract', async () => {
    const bundle = await loadBundle();
    const { normalizePolicyValue, clampIntervalTurns, policyStateOf } = bundle.exports;
    assert.equal(JSON.stringify(normalizePolicyValue(undefined)), JSON.stringify({ trigger: 'off', apply: 'draft', interval_turns: 5 }));
    assert.equal(JSON.stringify(normalizePolicyValue({ trigger: 'turn', apply: 'commit', interval_turns: 9 })), JSON.stringify({ trigger: 'turn', apply: 'commit', interval_turns: 9 }));
    // Unknown ids fall back per field, so one stale value cannot blank the card.
    assert.equal(JSON.stringify(normalizePolicyValue({ trigger: 'nope', apply: 'commit', interval_turns: 3 })), JSON.stringify({ trigger: 'off', apply: 'commit', interval_turns: 3 }));
    assert.equal(clampIntervalTurns(0), 1);
    assert.equal(clampIntervalTurns(99), 50);
    assert.equal(clampIntervalTurns('7'), 7);
    assert.equal(clampIntervalTurns('abc'), null);
    assert.equal(policyStateOf(null).status, 'loading');
    assert.equal(policyStateOf({ status: 'ready', writable: true, value: { trigger: 'turn' } }).trigger, 'turn');
  });

  it('renders the four trigger choices and the two save modes', async () => {
    const bundle = await loadBundle();
    const element = bundle.exports.PolicyCard({
      t: (key: string) => key,
      useCheckpointPolicy: () => ({ status: 'ready', writable: true, trigger: 'file_change', apply: 'draft', interval_turns: 5 }),
    }) as Element;

    assert.equal(element.type, 'li');
    assert.equal(element.props.className, 'lc-settings-card');
    assert.equal(element.props['data-agent-checkpoint-card'], 'agent-checkpoint');

    const rows = choices(element);
    assert.equal(JSON.stringify(rows.map((row) => row.id)), JSON.stringify([ 'off', 'file_change', 'turn', 'interval_turns', 'apply-draft', 'apply-commit' ]));
    assert.equal(rows.filter((row) => row.active === 'true').length, 2);
    assert.ok(rows.every((row) => row.disabled === false));

    const texts = collectText(element).join('\n');
    assert.match(texts, /policy\.name/);
    // Both save modes explain their consequence in the card body.
    assert.match(texts, /policy\.apply\.commit\.hint/);
    assert.match(texts, /policy\.note\.draft/);
  });

  it('locks the choices when the host says the namespace is read-only', async () => {
    const bundle = await loadBundle();
    const element = bundle.exports.PolicyCard({
      t: (key: string) => key,
      useCheckpointPolicy: () => ({ status: 'ready', writable: false, trigger: 'off', apply: 'draft', interval_turns: 5 }),
    }) as Element;
    assert.ok(choices(element).every((row) => row.disabled === true));
    assert.match(collectText(element).join('\n'), /policy\.readonly/);
  });

  it('explains when the host has no settings service at all', async () => {
    const bundle = await loadBundle();
    const element = bundle.exports.PolicyCard({
      t: (key: string) => key,
      useCheckpointPolicy: () => ({ status: 'unavailable', writable: false, trigger: 'off', apply: 'draft', interval_turns: 5 }),
    }) as Element;
    assert.match(collectText(element).join('\n'), /policy\.unavailable/);
  });

  it('persists a click immediately, without a save button', async () => {
    const bundle = await loadBundle();
    const writes: Array<{ field: string; value: unknown }> = [];
    let push: (() => void) | null = null;
    // The bound scope is the source of truth: `subscribe` only signals that it changed.
    let current: unknown = { status: 'ready', writable: true, value: { trigger: 'off', apply: 'draft', interval_turns: 5 } };
    const store = bundle.exports.createPolicyStore();
    const detach = store.attach({
      getSnapshot: () => current,
      subscribe: (listener: () => void) => {
        push = listener;
        return () => {
          push = null;
        };
      },
      set: (field: string, value: unknown) => {
        writes.push({ field, value });
        return Promise.resolve();
      },
    });

    // The click is applied locally first: the card must react before the round trip.
    store.set('trigger', 'turn');
    assert.equal(store.getSnapshot().trigger, 'turn');
    assert.equal(JSON.stringify(writes), JSON.stringify([ { field: 'trigger', value: 'turn' } ]));

    // Invalid values never reach the host.
    store.set('trigger', 'sometimes');
    store.set('interval_turns', 'abc');
    assert.equal(writes.length, 1);

    // The host echo replaces the local guess.
    current = { status: 'ready', writable: true, value: { trigger: 'interval_turns', apply: 'commit', interval_turns: 9 } };
    (push as (() => void) | null)?.();
    assert.equal(store.getSnapshot().trigger, 'interval_turns');
    assert.equal(store.getSnapshot().apply, 'commit');
    assert.equal(store.getSnapshot().interval_turns, 9);

    detach();
    assert.equal(push, null);
  });
});
