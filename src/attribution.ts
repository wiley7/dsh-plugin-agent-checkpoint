/**
 * Message-to-checkpoint attribution.
 *
 * The commit badge under an assistant reply used to report the *current* `HEAD`,
 * which rewrites history: every older reply silently starts claiming the newest
 * commit. What a reply should show is the checkpoint that was current when it
 * happened, so each message is attributed to the snapshot created in its own
 * turn (or, when that turn produced nothing, to the one still in force then).
 *
 * Attribution is a pure projection over two inputs:
 *
 *  - the session chronology read from the DSH session log
 *    ({@link module:dsh-plugin-agent-checkpoint/session} `SessionTimeline`), and
 *  - the checkpoint records this plugin wrote (`.dsh-checkpoint/**`).
 *
 * Nothing here touches git or the filesystem, which keeps it testable without a
 * live session.
 *
 * @module dsh-plugin-agent-checkpoint/attribution
 */

import type { SessionTimeline, SessionTurnWindow } from './session.js';

/** One snapshot that could be attributed to a message. */
export interface CheckpointPoint {
  id: string;
  title: string;
  status: 'draft' | 'confirmed';
  /** Epoch milliseconds. */
  createdAt: number;
  commitHash: string | null;
}

/** What one assistant message was looking at when it was written. */
export interface MessageAttribution {
  messageId: string;
  turn: number;
  /** Epoch milliseconds of the message itself. */
  at: number;
  checkpointId: string | null;
  title: string | null;
  status: 'draft' | 'confirmed' | null;
  commitHash: string | null;
  /** Short id used by the badge; null when no checkpoint applies. */
  short: string | null;
  createdAt: number | null;
  /** Turn the attributed checkpoint was created in, or null for "before any turn". */
  fromTurn: number | null;
  /** True when the checkpoint was already current before this message's turn. */
  inherited: boolean;
}

/** Characters kept from a checkpoint id for the badge (`ckpt-<ms>-<suffix>`). */
const SHORT_ID_LENGTH = 8;

/**
 * The part of a checkpoint id worth showing in a 20px-tall badge.
 * Ids look like `ckpt-1792582824171-fb62938a`, so the random suffix is what
 * distinguishes two neighbouring snapshots.
 */
export function shortCheckpointId(id: string | null | undefined): string | null {
  if (typeof id !== 'string' || id === '') return null;
  const parts = id.split('-');
  const tail = parts.length > 1 ? parts[parts.length - 1]! : id;
  if (tail.length <= SHORT_ID_LENGTH) return tail;
  return tail.slice(-SHORT_ID_LENGTH);
}

/** Index of the turn window that contains `at`, or -1 when it predates all of them. */
export function turnIndexForTime(turns: SessionTurnWindow[], at: number): number {
  let found = -1;
  for (let index = 0; index < turns.length; index += 1) {
    const window = turns[index]!;
    if (window.startAt <= at) found = index;
    else break;
  }
  return found;
}

/** Index of a turn number in the window list, or -1 when the log never opened it. */
function turnIndexOf(turns: SessionTurnWindow[], turn: number): number {
  for (let index = 0; index < turns.length; index += 1) {
    if (turns[index]!.turn === turn) return index;
  }
  return -1;
}

/**
 * Attribute every assistant message of a session to the checkpoint that was
 * current at that moment.
 *
 * Rules, in order of precedence:
 *  1. a checkpoint created inside the message's own turn wins (that is the save
 *     the reply triggered);
 *  2. otherwise the newest checkpoint from an earlier turn is reported, marked
 *     `inherited: true` — it was still the current snapshot;
 *  3. a checkpoint created *after* a message is never attributed to it.
 *
 * @param timeline - chronology read from the session log.
 * @param points - checkpoint records of the workspace, in any order.
 * @returns one entry per assistant message, oldest first.
 */
export function attributeMessages(timeline: SessionTimeline, points: CheckpointPoint[]): MessageAttribution[] {
  const turns = timeline.turns;
  const placed = points
    .filter((point) => Number.isFinite(point.createdAt))
    .map((point) => ({ point, turnIndex: turnIndexForTime(turns, point.createdAt) }))
    .sort((left, right) => left.turnIndex - right.turnIndex || left.point.createdAt - right.point.createdAt);

  const results: MessageAttribution[] = [];
  for (const message of timeline.messages) {
    const known = turnIndexOf(turns, message.turn);
    // When the log never opened a window for this turn, fall back to the clock:
    // anything saved after the reply itself must still not be attributed to it.
    const limit = known === -1 ? turnIndexForTime(turns, message.at) : known;
    const messageIndex = known;
    let chosen: { point: CheckpointPoint; turnIndex: number } | null = null;
    for (const candidate of placed) {
      // A checkpoint may be attributed to a turn only when that turn had already
      // started at the message — a later save must not rewrite an older reply.
      const available = candidate.turnIndex === -1 || (limit !== -1 && candidate.turnIndex <= limit);
      if (!available) continue;
      if (chosen === null || candidate.point.createdAt >= chosen.point.createdAt) chosen = candidate;
    }
    if (chosen === null) {
      results.push({
        messageId: message.messageId,
        turn: message.turn,
        at: message.at,
        checkpointId: null,
        title: null,
        status: null,
        commitHash: null,
        short: null,
        createdAt: null,
        fromTurn: null,
        inherited: false,
      });
      continue;
    }
    const { point, turnIndex } = chosen;
    results.push({
      messageId: message.messageId,
      turn: message.turn,
      at: message.at,
      checkpointId: point.id,
      title: point.title,
      status: point.status,
      commitHash: point.commitHash,
      short: shortCheckpointId(point.id),
      createdAt: point.createdAt,
      fromTurn: turnIndex === -1 ? null : (turns[turnIndex]?.turn ?? null),
      inherited: !(messageIndex !== -1 && turnIndex === messageIndex),
    });
  }
  return results;
}
