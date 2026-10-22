/**
 * The automatic-checkpoint trigger engine.
 *
 * The engine only decides *when* to save; the policy the operator picks in
 * Settings supplies the *what*, and {@link TriggerDeps.takeCheckpoint} supplies
 * the *how*. Keeping the decision here — rather than inside the host wiring —
 * makes every rule testable without a git repository or a DSH session:
 *
 * - a workspace is only taken from the session log, never from a fallback, so
 *   an unrelated launch directory can never be checkpointed by accident;
 * - a directory that is not a repository is skipped, never initialised: enabling
 *   checkpoints stays an explicit click in the UI;
 * - one save per turn at most, so a chatty session cannot loop;
 * - every failure is swallowed and logged, because a plugin must never break a
 *   turn because it could not snapshot it.
 */

import type { AutoPolicy, PolicyApply } from './policy.js';

/** The slice of a DSH session this engine reads. */
export interface TriggerSessionLike {
  id: string;
}

/** The slice of a DSH session event this engine reads. */
export interface TriggerEventLike {
  type: string;
  data?: unknown;
}

/** Why an automatic save was skipped. */
export type TriggerSkipReason =
  | 'not_a_turn_end'
  | 'trigger_off'
  | 'not_due'
  | 'already_fired'
  | 'no_workspace'
  | 'not_a_repository'
  | 'no_changes'
  | 'failed';

/** What the engine decided. */
export type TriggerOutcome =
  | {
      fired: true;
      reason: AutoPolicy['trigger'];
      turn: number | null;
      checkpointId: string;
      status: 'draft' | 'confirmed';
    }
  | { fired: false; reason: TriggerSkipReason; turn: number | null; message?: string };

/** The work the engine hands back to the host half. */
export interface TriggerCheckpointRequest {
  /** Absolute project directory resolved from the session log. */
  workspace: string;
  /** Session that finished the turn. */
  sessionId: string;
  /** Turn boundary that caused the save. */
  turn: number | null;
  /** Human-readable snapshot title. */
  title: string;
  /** Free-form remark stored with the snapshot. */
  remark: string;
  /** Tags stored with the snapshot. */
  tags: string[];
  /** Which policy produced the save. */
  trigger: AutoPolicy['trigger'];
  /** Whether to draft or commit. */
  apply: PolicyApply;
}

/** What {@link TriggerDeps.takeCheckpoint} produces. */
export interface TriggerCheckpointResult {
  checkpointId: string;
  status: 'draft' | 'confirmed';
}

/** Everything the engine needs from the outside world. */
export interface TriggerDeps {
  /** Live policy from Settings. */
  policy(): AutoPolicy;
  /** Project directory of a session, or null when the session names none. */
  workspaceFor(sessionId: string): Promise<string | null>;
  /** Whether a directory is the root of a git repository. */
  isRepository(workspace: string): Promise<boolean>;
  /** Whether the working tree has any change. */
  isDirty(workspace: string): Promise<boolean>;
  /** Capture the snapshot. */
  takeCheckpoint(request: TriggerCheckpointRequest): Promise<TriggerCheckpointResult>;
  /** stderr diagnostics. */
  log(message: string): void;
}

/** Per-session bookkeeping. */
export interface SessionTriggerState {
  /** Turns that ended in this session since the host started. */
  turns: number;
  /** Turn that produced the most recent save, if any. */
  lastFiredTurn: number | null;
  /** How many saves this engine produced for the session. */
  fired: number;
}

/** The slice of the plugin context used to subscribe to session events. */
export interface SessionEventSource {
  on(event: 'session/event', listener: (session: TriggerSessionLike, event: TriggerEventLike) => void): unknown;
}

/** The engine surface. */
export interface TriggerEngine {
  /** Subscribe to the host's session event bus. */
  observe(ctx: SessionEventSource): void;
  /** Decide and run for one session event. */
  handle(session: TriggerSessionLike, event: TriggerEventLike): Promise<TriggerOutcome>;
  /** Read the bookkeeping of one session. */
  state(sessionId: string): SessionTriggerState | undefined;
  /** Forget one session, or every session. */
  reset(sessionId?: string): void;
}

/** Read the turn number out of a `turn/end` payload. */
function readTurn(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null;
  const turn = (data as Record<string, unknown>).turn;
  return typeof turn === 'number' && Number.isFinite(turn) ? turn : null;
}

/** Skip outcome helper. */
function skip(reason: TriggerSkipReason, turn: number | null, message?: string): TriggerOutcome {
  return message === undefined ? { fired: false, reason, turn } : { fired: false, reason, turn, message };
}

/** One-line title for a snapshot the plugin took on its own. */
export function automaticTitle(turn: number | null): string {
  return turn === null ? 'Automatic checkpoint' : `Automatic checkpoint · turn ${turn}`;
}

/** Remark stored with a snapshot the plugin took on its own. */
export function automaticRemark(policy: AutoPolicy, turn: number | null): string {
  const when = turn === null ? 'after a turn' : `after turn ${turn}`;
  switch (policy.trigger) {
    case 'file_change':
      return `Saved automatically ${when}: the turn changed files.`;
    case 'turn':
      return `Saved automatically ${when}: every turn saves in this mode.`;
    case 'interval_turns':
      return `Saved automatically ${when}: every ${policy.interval_turns} turns save in this mode.`;
    default:
      return `Saved automatically ${when}.`;
  }
}

/** Tags attached to a snapshot the plugin took on its own. */
export function automaticTags(policy: AutoPolicy): string[] {
  return [ 'auto', policy.trigger ];
}

/**
 * Build a trigger engine.
 * @param deps - host callbacks.
 * @returns the engine.
 */
export function createTriggerEngine(deps: TriggerDeps): TriggerEngine {
  const sessions = new Map<string, SessionTriggerState>();
  /** Per-session queue: one evaluation at a time, in event order. */
  const queues = new Map<string, Promise<unknown>>();

  const stateFor = (sessionId: string): SessionTriggerState => {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) return existing;
    const created: SessionTriggerState = { turns: 0, lastFiredTurn: null, fired: 0 };
    sessions.set(sessionId, created);
    return created;
  };

  /** Serialise evaluations of one session so a slow save cannot interleave. */
  const enqueue = <T>(sessionId: string, task: () => Promise<T>): Promise<T> => {
    const previous = queues.get(sessionId) ?? Promise.resolve();
    const next = previous.then(task, task);
    queues.set(
      sessionId,
      next.catch(() => undefined),
    );
    return next;
  };

  const evaluate = async (
    sessionId: string,
    turn: number | null,
    state: SessionTriggerState,
  ): Promise<TriggerOutcome> => {
    const policy = deps.policy();
    if (policy.trigger === 'off') return skip('trigger_off', turn);
    if (turn !== null && state.lastFiredTurn === turn) return skip('already_fired', turn);
    if (policy.trigger === 'interval_turns' && state.turns % policy.interval_turns !== 0) return skip('not_due', turn);

    const workspace = await deps.workspaceFor(sessionId);
    if (workspace === null || workspace.length === 0) return skip('no_workspace', turn);
    if (!(await deps.isRepository(workspace))) return skip('not_a_repository', turn);
    // `file_change` and `interval_turns` exist precisely to skip quiet turns;
    // `turn` saves the conversation too, so a clean tree is fine there.
    const needsChange = policy.trigger === 'file_change' || policy.trigger === 'interval_turns';
    if (needsChange && !(await deps.isDirty(workspace))) return skip('no_changes', turn);

    try {
      const result = await deps.takeCheckpoint({
        workspace,
        sessionId,
        turn,
        title: automaticTitle(turn),
        remark: automaticRemark(policy, turn),
        tags: automaticTags(policy),
        trigger: policy.trigger,
        apply: policy.apply,
      });
      state.lastFiredTurn = turn;
      state.fired += 1;
      deps.log(
        `automatic checkpoints: ${result.status} ${result.checkpointId} in ${workspace}` +
          (turn === null ? '' : ` after turn ${turn}`) +
          ` (${policy.trigger})`,
      );
      return { fired: true, reason: policy.trigger, turn, checkpointId: result.checkpointId, status: result.status };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log(`automatic checkpoints: skipped after turn ${turn ?? '?'} (${message})`);
      return skip('failed', turn, message);
    }
  };

  return {
    observe(ctx: SessionEventSource): void {
      if (typeof ctx?.on !== 'function') return;
      ctx.on('session/event', (session, event) => {
        void this.handle(session, event).catch(() => undefined);
      });
    },

    async handle(session: TriggerSessionLike, event: TriggerEventLike): Promise<TriggerOutcome> {
      const sessionId = session?.id;
      if (typeof sessionId !== 'string' || sessionId.length === 0) return skip('not_a_turn_end', null);
      if (event?.type === 'session/disposed') {
        this.reset(sessionId);
        return skip('not_a_turn_end', null);
      }
      if (event?.type !== 'turn/end') return skip('not_a_turn_end', null);
      const turn = readTurn(event.data);
      const state = stateFor(sessionId);
      state.turns += 1;
      return await enqueue(sessionId, () => evaluate(sessionId, turn, state));
    },

    state(sessionId: string): SessionTriggerState | undefined {
      const existing = sessions.get(sessionId);
      return existing === undefined ? undefined : { ...existing };
    },

    reset(sessionId?: string): void {
      if (sessionId === undefined) {
        sessions.clear();
        queues.clear();
        return;
      }
      sessions.delete(sessionId);
      queues.delete(sessionId);
    },
  };
}
