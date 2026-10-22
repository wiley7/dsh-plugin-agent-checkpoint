/**
 * Policy / configuration loading for dsh-plugin-agent-checkpoint.
 *
 * Configuration is read from `checkpoint.config.json` in the workspace root.
 * Missing or malformed values fall back to the built-in defaults so the plugin
 * never blocks a session on a broken config file.
 *
 * @module dsh-plugin-agent-checkpoint/config
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_PROJECT_MODE,
  INTERVAL_TURNS_MAX,
  INTERVAL_TURNS_MIN,
  PROJECT_MODES,
  isProjectMode,
  type ProjectMode,
} from './policy.js';
import type { CheckpointConfig } from './types.js';

/** Name of the configuration file read from the workspace root. */
export const CONFIG_FILENAME = 'checkpoint.config.json';

/**
 * Default ignore patterns. These are written into `.git/info/exclude` (in a
 * managed block) so drafts never capture vendored or build output.
 */
export const DEFAULT_IGNORE_PATTERNS: readonly string[] = [
  'node_modules',
  '.venv',
  'dist',
  'build',
];

/** Built-in defaults for every configurable knob. */
export const DEFAULT_CONFIG: Readonly<CheckpointConfig> = Object.freeze({
  auto_draft_on_milestone: true,
  ignore_patterns: [...DEFAULT_IGNORE_PATTERNS],
  max_draft_count: 10,
  max_context_message_chars: 1200,
  max_context_messages: 40,
  max_context_bytes: 512 * 1024,
  max_diff_chars: 100_000,
  confirmation_ttl_seconds: 600,
  mode: DEFAULT_PROJECT_MODE,
  interval_turns: 5,
});

/** Result of reading the workspace configuration. */
export interface LoadedConfig {
  config: CheckpointConfig;
  /** Absolute path that was consulted. */
  path: string;
  /** True when the file existed and parsed successfully. */
  found: boolean;
  /** Keys that were present but rejected, with a reason. */
  warnings: string[];
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    const trimmed = entry.trim();
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

function asPositiveInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}

/**
 * Validate an arbitrary parsed object and merge it over the defaults.
 *
 * Every rejected key is surfaced in `warnings` instead of throwing, because a
 * partially broken config must not make the plugin unusable.
 */
export function normalizeConfig(
  raw: unknown,
): { config: CheckpointConfig; warnings: string[] } {
  const warnings: string[] = [];
  const config: CheckpointConfig = {
    ...DEFAULT_CONFIG,
    ignore_patterns: [...DEFAULT_CONFIG.ignore_patterns],
  };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { config, warnings: [ 'config file must contain a JSON object' ] };
  }
  const input = raw as Record<string, unknown>;

  if ('auto_draft_on_milestone' in input) {
    const value = input.auto_draft_on_milestone;
    if (typeof value === 'boolean') config.auto_draft_on_milestone = value;
    else warnings.push('auto_draft_on_milestone must be a boolean');
  }
  if ('ignore_patterns' in input) {
    const value = asStringArray(input.ignore_patterns);
    if (value) config.ignore_patterns = value;
    else warnings.push('ignore_patterns must be an array of non-empty strings');
  }
  if ('max_draft_count' in input) {
    const value = asPositiveInt(input.max_draft_count, 1, 1000);
    if (value !== null) config.max_draft_count = value;
    else warnings.push('max_draft_count must be an integer between 1 and 1000');
  }
  if ('max_context_message_chars' in input) {
    const value = asPositiveInt(input.max_context_message_chars, 80, 100_000);
    if (value !== null) config.max_context_message_chars = value;
    else warnings.push('max_context_message_chars must be an integer between 80 and 100000');
  }
  if ('max_context_messages' in input) {
    const value = asPositiveInt(input.max_context_messages, 1, 500);
    if (value !== null) config.max_context_messages = value;
    else warnings.push('max_context_messages must be an integer between 1 and 500');
  }
  if ('max_context_bytes' in input) {
    const value = asPositiveInt(input.max_context_bytes, 4096, 16 * 1024 * 1024);
    if (value !== null) config.max_context_bytes = value;
    else warnings.push('max_context_bytes must be an integer between 4096 and 16777216');
  }
  if ('max_diff_chars' in input) {
    const value = asPositiveInt(input.max_diff_chars, 1024, 4 * 1024 * 1024);
    if (value !== null) config.max_diff_chars = value;
    else warnings.push('max_diff_chars must be an integer between 1024 and 4194304');
  }
  if ('confirmation_ttl_seconds' in input) {
    const value = asPositiveInt(input.confirmation_ttl_seconds, 30, 86_400);
    if (value !== null) config.confirmation_ttl_seconds = value;
    else warnings.push('confirmation_ttl_seconds must be an integer between 30 and 86400');
  }
  if ('mode' in input) {
    if (isProjectMode(input.mode)) config.mode = input.mode;
    else warnings.push(`mode must be one of ${PROJECT_MODES.join(', ')}`);
  }
  if ('interval_turns' in input) {
    const value = asPositiveInt(input.interval_turns, INTERVAL_TURNS_MIN, INTERVAL_TURNS_MAX);
    if (value !== null) config.interval_turns = value;
    else warnings.push(`interval_turns must be an integer between ${INTERVAL_TURNS_MIN} and ${INTERVAL_TURNS_MAX}`);
  }
  return { config, warnings };
}

/**
 * Load and normalize `checkpoint.config.json` from `workspacePath`.
 *
 * A missing file is not an error: defaults apply and `found` is false.
 */
export async function loadConfig(workspacePath: string): Promise<LoadedConfig> {
  const configPath = path.join(workspacePath, CONFIG_FILENAME);
  let text: string;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { config: { ...DEFAULT_CONFIG }, path: configPath, found: false, warnings: [] };
    }
    return {
      config: { ...DEFAULT_CONFIG },
      path: configPath,
      found: false,
      warnings: [ `cannot read ${CONFIG_FILENAME}: ${(error as Error).message}` ],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      config: { ...DEFAULT_CONFIG },
      path: configPath,
      found: true,
      warnings: [ `invalid JSON in ${CONFIG_FILENAME}: ${(error as Error).message}` ],
    };
  }

  const { config, warnings } = normalizeConfig(parsed);
  return { config, path: configPath, found: true, warnings };
}

/**
 * Raised when the project config exists but cannot be rewritten safely.
 *
 * Refusing is the whole point: silently replacing an unparseable
 * `checkpoint.config.json` would throw away whatever the repository owner put
 * in it.
 */
export class ConfigError extends Error {
  readonly code: 'config_invalid' | 'config_unreadable';

  constructor(code: 'config_invalid' | 'config_unreadable', message: string) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

/** Result of writing a project's preset back to disk. */
export interface WrittenProjectMode {
  /** Absolute path of the file that was written. */
  path: string;
  /** True when the file did not exist before. */
  created: boolean;
  /** The preset now stored in the file. */
  mode: ProjectMode;
  /** The cadence now stored in the file. */
  intervalTurns: number;
  /** The whole file re-read through the normal validator. */
  config: CheckpointConfig;
  /** Keys that were present but rejected, with a reason. */
  warnings: string[];
}

/** Clamp a cadence into the documented range. */
function clampTurns(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const rounded = Math.round(value);
  if (rounded < INTERVAL_TURNS_MIN) return INTERVAL_TURNS_MIN;
  if (rounded > INTERVAL_TURNS_MAX) return INTERVAL_TURNS_MAX;
  return rounded;
}

/**
 * Store a project's checkpoint preset in its own `checkpoint.config.json`.
 *
 * Every other key in the file is preserved verbatim, so a repository that
 * already configures ignore patterns or context limits keeps them. The write is
 * temp-file + rename, matching the rest of the plugin's storage: a crash must
 * not leave a half-written config behind.
 *
 * @param workspacePath - repository root owning the config.
 * @param options - the preset to store and, optionally, its cadence.
 * @returns what is now on disk, re-validated.
 */
export async function writeProjectMode(
  workspacePath: string,
  options: { mode: ProjectMode; intervalTurns?: number },
): Promise<WrittenProjectMode> {
  const configPath = path.join(workspacePath, CONFIG_FILENAME);
  let raw: Record<string, unknown> = {};
  let created = true;
  let text: string | null = null;
  try {
    text = await readFile(configPath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new ConfigError(
        'config_unreadable',
        `cannot read ${CONFIG_FILENAME}: ${(error as Error).message}`,
      );
    }
  }
  if (text !== null) {
    created = false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new ConfigError(
        'config_invalid',
        `refusing to overwrite ${CONFIG_FILENAME}: ${(error as Error).message}`,
      );
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ConfigError(
        'config_invalid',
        `refusing to overwrite ${CONFIG_FILENAME}: it does not contain a JSON object`,
      );
    }
    raw = parsed as Record<string, unknown>;
  }

  const previous = normalizeConfig(raw).config;
  const intervalTurns = clampTurns(options.intervalTurns, previous.interval_turns);
  const next: Record<string, unknown> = { ...raw, mode: options.mode, interval_turns: intervalTurns };
  const body = `${JSON.stringify(next, null, 2)}\n`;
  const tmpPath = `${configPath}.${process.pid.toString(36)}.tmp`;
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(tmpPath, body, 'utf8');
  await rename(tmpPath, configPath);
  const { config, warnings } = normalizeConfig(next);
  return { path: configPath, created, mode: config.mode, intervalTurns: config.interval_turns, config, warnings };
}

/** Directory of this module, used to exclude the plugin's own sources if needed. */
export function pluginRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}
