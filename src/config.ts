/**
 * Policy / configuration loading for dsh-plugin-agent-checkpoint.
 *
 * Configuration is read from `checkpoint.config.json` in the workspace root.
 * Missing or malformed values fall back to the built-in defaults so the plugin
 * never blocks a session on a broken config file.
 *
 * @module dsh-plugin-agent-checkpoint/config
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Directory of this module, used to exclude the plugin's own sources if needed. */
export function pluginRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}
