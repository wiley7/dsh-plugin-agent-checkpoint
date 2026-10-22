/**
 * Config loading and validation tests.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { CONFIG_FILENAME, ConfigError, DEFAULT_CONFIG, loadConfig, normalizeConfig, writeProjectMode } from '../config.js';

describe('config', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'ckpt-config-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('falls back to defaults when no config file exists', async () => {
    const loaded = await loadConfig(dir);
    assert.equal(loaded.found, false);
    assert.equal(loaded.config.auto_draft_on_milestone, true);
    assert.equal(loaded.config.max_draft_count, 10);
    assert.deepEqual(loaded.config.ignore_patterns, [ 'node_modules', '.venv', 'dist', 'build' ]);
    assert.equal(loaded.warnings.length, 0);
  });

  it('merges valid values over the defaults', async () => {
    const loaded = normalizeConfig({
      auto_draft_on_milestone: false,
      max_draft_count: 3,
      ignore_patterns: [ 'vendor', '.cache' ],
    });
    assert.equal(loaded.config.auto_draft_on_milestone, false);
    assert.equal(loaded.config.max_draft_count, 3);
    assert.deepEqual(loaded.config.ignore_patterns, [ 'vendor', '.cache' ]);
    assert.equal(loaded.warnings.length, 0);
  });

  it('rejects invalid values with warnings instead of throwing', () => {
    const loaded = normalizeConfig({
      auto_draft_on_milestone: 'yes',
      max_draft_count: -2,
      ignore_patterns: 'node_modules',
      max_context_messages: 0,
      confirmation_ttl_seconds: 5,
    });
    assert.equal(loaded.config.auto_draft_on_milestone, DEFAULT_CONFIG.auto_draft_on_milestone);
    assert.equal(loaded.config.max_draft_count, DEFAULT_CONFIG.max_draft_count);
    assert.deepEqual(loaded.config.ignore_patterns, [ ...DEFAULT_CONFIG.ignore_patterns ]);
    assert.equal(loaded.warnings.length, 5);
  });

  it('survives malformed JSON in checkpoint.config.json', async () => {
    const broken = await mkdtemp(path.join(os.tmpdir(), 'ckpt-config-broken-'));
    try {
      await writeFile(path.join(broken, 'checkpoint.config.json'), '{ not json', 'utf8');
      const loaded = await loadConfig(broken);
      assert.equal(loaded.found, true);
      assert.equal(loaded.config.max_draft_count, DEFAULT_CONFIG.max_draft_count);
      assert.match(loaded.warnings.join('\n'), /invalid JSON/);
    } finally {
      await rm(broken, { recursive: true, force: true });
    }
  });

  it('validates the per-project preset fields', () => {
    const loaded = normalizeConfig({ mode: 'commit_each_turn', interval_turns: 9 });
    assert.equal(loaded.config.mode, 'commit_each_turn');
    assert.equal(loaded.config.interval_turns, 9);
    assert.equal(loaded.warnings.length, 0);
    assert.equal(DEFAULT_CONFIG.mode, 'inherit');

    // Unknown presets and out-of-range cadences degrade to the default, they do
    // not throw: a hand-edited project file must never break the host.
    const bad = normalizeConfig({ mode: 'yolo', interval_turns: 0 });
    assert.equal(bad.config.mode, 'inherit');
    assert.equal(bad.config.interval_turns, DEFAULT_CONFIG.interval_turns);
    assert.match(bad.warnings.join('\n'), /mode must be one of/);
    assert.match(bad.warnings.join('\n'), /interval_turns/);
  });

  it('writes a preset while keeping every other key in the file', async () => {
    const local = await mkdtemp(path.join(os.tmpdir(), 'ckpt-config-write-'));
    try {
      await writeFile(
        path.join(local, CONFIG_FILENAME),
        JSON.stringify({ max_draft_count: 3, ignore_patterns: [ 'coverage' ], unknown_future_key: true }, null, 2),
        'utf8',
      );
      const written = await writeProjectMode(local, { mode: 'commit_each_turn', intervalTurns: 9 });
      assert.equal(written.created, false);
      assert.equal(written.mode, 'commit_each_turn');
      assert.equal(written.intervalTurns, 9);

      const loaded = await loadConfig(local);
      assert.equal(loaded.config.mode, 'commit_each_turn');
      assert.equal(loaded.config.interval_turns, 9);
      assert.equal(loaded.config.max_draft_count, 3);
      assert.deepEqual(loaded.config.ignore_patterns, [ 'coverage' ]);
      const raw = JSON.parse(await readFile(path.join(local, CONFIG_FILENAME), 'utf8')) as Record<string, unknown>;
      assert.equal(raw.unknown_future_key, true, 'unrelated keys survive a preset write');
    } finally {
      await rm(local, { recursive: true, force: true });
    }
  });

  it('creates the file on first write and refuses to overwrite a broken one', async () => {
    const local = await mkdtemp(path.join(os.tmpdir(), 'ckpt-config-create-'));
    try {
      const created = await writeProjectMode(local, { mode: 'off' });
      assert.equal(created.created, true);
      assert.equal(created.mode, 'off');
      assert.equal(created.intervalTurns, DEFAULT_CONFIG.interval_turns);

      await writeFile(path.join(local, CONFIG_FILENAME), '{ not json', 'utf8');
      await assert.rejects(
        () => writeProjectMode(local, { mode: 'draft_each_turn' }),
        (error: unknown) => error instanceof ConfigError && error.code === 'config_invalid',
      );
    } finally {
      await rm(local, { recursive: true, force: true });
    }
  });

  it('reads and normalizes a real config file', async () => {
    const local = await mkdtemp(path.join(os.tmpdir(), 'ckpt-config-real-'));
    try {
      await writeFile(
        path.join(local, 'checkpoint.config.json'),
        JSON.stringify({ max_draft_count: 4, ignore_patterns: [ 'coverage' ] }),
        'utf8',
      );
      const loaded = await loadConfig(local);
      assert.equal(loaded.found, true);
      assert.equal(loaded.config.max_draft_count, 4);
      assert.deepEqual(loaded.config.ignore_patterns, [ 'coverage' ]);
    } finally {
      await rm(local, { recursive: true, force: true });
    }
  });
});
