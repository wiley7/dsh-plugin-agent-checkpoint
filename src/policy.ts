/**
 * The `agent-checkpoint` settings namespace: when the plugin saves by itself.
 *
 * This is the only state the settings card edits, and everything the trigger
 * engine does is derived from it. The defaults are deliberately conservative:
 * automatic checkpoints are off, and when they are switched on they create
 * drafts rather than commits, so turning the feature on never writes history
 * behind the operator's back.
 *
 * `ctx.settings.register` wants a callable schemastery schema. schemastery is
 * an optional peer that ships with the DSH app rather than with this package,
 * so it is loaded through `createRequire` at registration time and a minimal
 * hand-written schema takes over when the peer is not resolvable: a missing
 * optional peer must cost the settings card, never the host half.
 */

import { createRequire } from 'node:module';

/** Namespace the settings card and this module agree on. */
export const POLICY_NAMESPACE = 'agent-checkpoint';

/** Tools that may save on their own. */
export const POLICY_TRIGGERS = [ 'off', 'file_change', 'turn', 'interval_turns' ] as const;

/** The values `trigger` may hold. */
export type PolicyTrigger = (typeof POLICY_TRIGGERS)[number];

/** How an automatic checkpoint lands. */
export const POLICY_APPLIES = [ 'draft', 'commit' ] as const;

/** The values `apply` may hold. */
export type PolicyApply = (typeof POLICY_APPLIES)[number];

/** Resolved automatic-checkpoint policy. */
export interface AutoPolicy {
  /** Which moment makes the plugin save (or `off`). */
  trigger: PolicyTrigger;
  /** Drafts wait for a human; commits write history immediately. */
  apply: PolicyApply;
  /** Distance between saves when `trigger` is `interval_turns`. */
  interval_turns: number;
}

/** What the plugin does before the operator touches the settings card. */
export const DEFAULT_AUTO_POLICY: AutoPolicy = {
  trigger: 'off',
  apply: 'draft',
  interval_turns: 5,
};

/** Inclusive bounds for `interval_turns`. */
export const INTERVAL_TURNS_MIN = 1;
/** Inclusive bounds for `interval_turns`. */
export const INTERVAL_TURNS_MAX = 50;

/**
 * Presets a single project may choose, stored in its own
 * `checkpoint.config.json`.
 *
 * The profile-wide settings are one answer for every repository. Real work does
 * not look like that: a repository where every save should be a commit and a
 * scratch repository where nothing should happen by itself want different
 * answers. A preset is the coarse, self-explanatory choice ("save a draft when
 * files change") that maps onto the same `AutoPolicy` the trigger engine
 * already understands, so there is still exactly one engine and one policy
 * shape — only the source of the answer differs.
 */
export const PROJECT_MODES = [
  'inherit',
  'off',
  'draft_on_change',
  'draft_each_turn',
  'commit_on_change',
  'commit_each_turn',
  'interval',
] as const;

/** The values `mode` may hold in `checkpoint.config.json`. */
export type ProjectMode = (typeof PROJECT_MODES)[number];

/** A project that says nothing follows the profile settings. */
export const DEFAULT_PROJECT_MODE: ProjectMode = 'inherit';

/** Whether a value is one of the accepted project modes. */
export function isProjectMode(value: unknown): value is ProjectMode {
  return typeof value === 'string' && (PROJECT_MODES as readonly string[]).includes(value);
}

/**
 * Coerce whatever the project config holds into a usable mode.
 * @param value - the raw `mode` value, of unknown shape.
 * @returns a known mode, `inherit` when the value is not one.
 */
export function normalizeProjectMode(value: unknown): ProjectMode {
  return isProjectMode(value) ? value : DEFAULT_PROJECT_MODE;
}

/**
 * Translate a project preset into the policy the trigger engine consumes.
 *
 * `null` means "this project does not decide", which is deliberately different
 * from `off` (this project decided that nothing may be saved).
 * @param mode - the project's preset.
 * @param intervalTurns - the project's preferred cadence for `interval`.
 * @returns the overriding policy, or `null` to fall back to the settings.
 */
export function projectPolicyOf(mode: ProjectMode, intervalTurns: number): AutoPolicy | null {
  switch (mode) {
    case 'off':
      return { trigger: 'off', apply: 'draft', interval_turns: clampInterval(intervalTurns) };
    case 'draft_on_change':
      return { trigger: 'file_change', apply: 'draft', interval_turns: clampInterval(intervalTurns) };
    case 'draft_each_turn':
      return { trigger: 'turn', apply: 'draft', interval_turns: clampInterval(intervalTurns) };
    case 'commit_on_change':
      return { trigger: 'file_change', apply: 'commit', interval_turns: clampInterval(intervalTurns) };
    case 'commit_each_turn':
      return { trigger: 'turn', apply: 'commit', interval_turns: clampInterval(intervalTurns) };
    case 'interval':
      return { trigger: 'interval_turns', apply: 'draft', interval_turns: clampInterval(intervalTurns) };
    case 'inherit':
    default:
      return null;
  }
}

/** Where a policy value came from. */
export type PolicySource = 'settings' | 'defaults';

/** A schema the settings service can resolve and serialize. */
export type PolicySchemaLike = ((value: unknown) => unknown) & { toJSON(): unknown };

/** The live policy the trigger engine reads. */
export interface PolicyState {
  /** Current resolved value. */
  get(): AutoPolicy;
  /** Whether the value came from the settings service or the built-in default. */
  source(): PolicySource;
  /** Adopt a value the settings service resolved. */
  adopt(value: unknown): void;
}

/** The slice of `ctx.settings` this module uses. */
export interface SettingsScopeLike {
  get(): unknown;
  watch(callback: (next: unknown, previous: unknown) => void | Promise<void>): () => void;
}

/** The slice of `ctx.settings` this module uses. */
export interface SettingsServiceLike {
  register(namespace: string, schema: PolicySchemaLike, options?: { base?: unknown; applies?: 'live' | 'restart' }): SettingsScopeLike;
}

/** The slice of a scoped Cordis context this module uses. */
export interface SettingsContextLike {
  settings?: SettingsServiceLike;
}

/** The slice of the plugin context the settings wiring needs. */
export interface PolicyHostContextLike {
  inject?: (dependencies: string[], callback: (scoped: SettingsContextLike) => void) => unknown;
}

/** Options for {@link installPolicySettings}. */
export interface InstallPolicyOptions {
  /** stderr sink used for one-line diagnostics. */
  log?: (message: string) => void;
}

/** Outcome of {@link installPolicySettings}. */
export interface PolicyInstallation {
  /** True when a settings scope was registered and adopted. */
  registered: boolean;
  /** Which schema builder was used. */
  schema: 'schemastery' | 'fallback' | 'none';
}

/** Clamp a number into the documented interval range. */
function clampInterval(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_AUTO_POLICY.interval_turns;
  const rounded = Math.round(value);
  if (rounded < INTERVAL_TURNS_MIN) return INTERVAL_TURNS_MIN;
  if (rounded > INTERVAL_TURNS_MAX) return INTERVAL_TURNS_MAX;
  return rounded;
}

/** Whether a value is one of the accepted trigger ids. */
export function isPolicyTrigger(value: unknown): value is PolicyTrigger {
  return typeof value === 'string' && (POLICY_TRIGGERS as readonly string[]).includes(value);
}

/** Whether a value is one of the accepted apply modes. */
export function isPolicyApply(value: unknown): value is PolicyApply {
  return typeof value === 'string' && (POLICY_APPLIES as readonly string[]).includes(value);
}

/**
 * Coerce whatever the settings document holds into a usable policy.
 *
 * Unknown ids fall back to the defaults instead of throwing: a hand-edited
 * `settings.json` must not be able to break plugin startup.
 * @param raw - the resolved settings section, of unknown shape.
 * @returns a policy with every field valid.
 */
export function normalizeAutoPolicy(raw: unknown): AutoPolicy {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_AUTO_POLICY };
  const record = raw as Record<string, unknown>;
  return {
    trigger: isPolicyTrigger(record.trigger) ? record.trigger : DEFAULT_AUTO_POLICY.trigger,
    apply: isPolicyApply(record.apply) ? record.apply : DEFAULT_AUTO_POLICY.apply,
    interval_turns:
      typeof record.interval_turns === 'number' ? clampInterval(record.interval_turns) : DEFAULT_AUTO_POLICY.interval_turns,
  };
}

/**
 * Hold the current policy for the trigger engine to read.
 * @param initial - optional starting value (defaults when absent).
 * @returns the mutable state handle.
 */
export function createPolicyState(initial?: unknown): PolicyState {
  let value = normalizeAutoPolicy(initial);
  let source: PolicySource = initial === undefined ? 'defaults' : 'settings';
  return {
    get: () => value,
    source: () => source,
    adopt: (next: unknown) => {
      value = normalizeAutoPolicy(next);
      source = 'settings';
    },
  };
}

/**
 * The schema used when schemastery is unavailable.
 *
 * It is callable, so the settings service can resolve a layer stack, and it
 * carries a JSON description of the fields so a generic settings surface still
 * has something to render.
 * @returns a schemastery-shaped fallback schema.
 */
export function createFallbackPolicySchema(): PolicySchemaLike {
  const schema = (value: unknown): AutoPolicy => normalizeAutoPolicy(value);
  schema.toJSON = () => ({
    uid: 3,
    refs: {
      0: { type: 'string', meta: { default: DEFAULT_AUTO_POLICY.trigger, description: POLICY_TRIGGERS.join(' | ') } },
      1: { type: 'string', meta: { default: DEFAULT_AUTO_POLICY.apply, description: POLICY_APPLIES.join(' | ') } },
      2: {
        type: 'number',
        meta: { default: DEFAULT_AUTO_POLICY.interval_turns, min: INTERVAL_TURNS_MIN, max: INTERVAL_TURNS_MAX },
      },
      3: { type: 'object', meta: { default: {} }, dict: { trigger: 0, apply: 1, interval_turns: 2 } },
    },
  });
  return schema;
}

/** The slice of the schemastery factory this module builds schemas with. */
interface SchemasteryFactoryLike {
  object(fields: Record<string, unknown>): PolicySchemaLike;
  union(list: unknown[]): { default(value: unknown): unknown };
  const(value: string): unknown;
  number(): { min(value: number): { max(value: number): { default(value: number): unknown } } };
}

/**
 * Load schemastery from the DSH installation that owns this plugin.
 *
 * A bare specifier is assembled at runtime so bundlers and type checkers never
 * treat the optional peer as a hard dependency of this package.
 * @returns the schema factory, or null when the peer is not resolvable.
 */
export function loadSchemastery(): SchemasteryFactoryLike | null {
  try {
    const requireFromPlugin = createRequire(import.meta.url);
    const specifier = [ '@deepseek-ai', 'schemastery' ].join('/');
    const loaded = requireFromPlugin(specifier) as Record<string, unknown>;
    const factory = (loaded?.default ?? loaded?.z ?? loaded) as Partial<SchemasteryFactoryLike> | undefined;
    if (typeof factory?.object !== 'function') return null;
    if (typeof factory.union !== 'function' || typeof factory.const !== 'function' || typeof factory.number !== 'function') {
      return null;
    }
    return factory as SchemasteryFactoryLike;
  } catch {
    return null;
  }
}

/**
 * Build the schema the settings service resolves the namespace with.
 * @returns the schema plus which builder produced it.
 */
export function createPolicySchema(): { schema: PolicySchemaLike; builder: 'schemastery' | 'fallback' } {
  const z = loadSchemastery();
  if (z !== null) {
    try {
      const schema = z.object({
        trigger: z.union(POLICY_TRIGGERS.map((id) => z.const(id))).default(DEFAULT_AUTO_POLICY.trigger),
        apply: z.union(POLICY_APPLIES.map((id) => z.const(id))).default(DEFAULT_AUTO_POLICY.apply),
        interval_turns: z
          .number()
          .min(INTERVAL_TURNS_MIN)
          .max(INTERVAL_TURNS_MAX)
          .default(DEFAULT_AUTO_POLICY.interval_turns),
      });
      // Resolving the empty layer stack proves the schema is usable before the
      // settings service depends on it.
      const defaults = normalizeAutoPolicy(schema({}));
      if (defaults.trigger === DEFAULT_AUTO_POLICY.trigger && typeof schema.toJSON === 'function') {
        return { schema, builder: 'schemastery' };
      }
    } catch {
      // fall through to the hand-written schema
    }
  }
  return { schema: createFallbackPolicySchema(), builder: 'fallback' };
}

/** One-line stderr diagnostic. */
function stderrLog(message: string): void {
  process.stderr.write(`dsh-agent-checkpoint: ${message}\n`);
}

/**
 * Register the `agent-checkpoint` namespace and follow its value.
 *
 * The registration is skipped silently when the host has no settings service
 * (headless or an older DSH); automatic checkpoints then stay at their
 * defaults, which is exactly the pre-settings behaviour.
 * @param ctx - the plugin context.
 * @param state - the policy state the trigger engine reads.
 * @param options - logging hook.
 * @returns what was registered, for tests and diagnostics.
 */
export function installPolicySettings(
  ctx: PolicyHostContextLike,
  state: PolicyState,
  options: InstallPolicyOptions = {},
): PolicyInstallation {
  const log = options.log ?? stderrLog;
  if (typeof ctx.inject !== 'function') return { registered: false, schema: 'none' };
  let installation: PolicyInstallation = { registered: false, schema: 'none' };
  ctx.inject([ 'settings' ], (scoped: SettingsContextLike) => {
    const settings = scoped.settings;
    if (settings === undefined || typeof settings.register !== 'function') return;
    const { schema, builder } = createPolicySchema();
    try {
      const scope = settings.register(POLICY_NAMESPACE, schema, { base: DEFAULT_AUTO_POLICY });
      state.adopt(scope.get());
      scope.watch((next: unknown) => {
        state.adopt(next);
      });
      installation = { registered: true, schema: builder };
      log(`automatic checkpoints: registered settings namespace "${POLICY_NAMESPACE}" (${builder} schema)`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`automatic checkpoints: could not register settings namespace "${POLICY_NAMESPACE}" (${message})`);
    }
  });
  return installation;
}
