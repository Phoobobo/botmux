/**
 * One structured notice when a turn reaches `turn_terminal`.
 *
 * Integrators can subscribe to the `turn.finished` hook or to `GET /api/events`
 * instead of polling. The sender is the turn's own reply-target sender. A turn
 * with no sender omits `senderOpenId`; the session owner is not a substitute.
 */
import { dashboardEventBus } from './dashboard-events.js';
import { pickTurnReplyTarget } from './reply-target.js';
import { emitHookEventLocal } from '../services/hook-runner.js';
import { logger } from '../utils/logger.js';
import type { Session } from '../types.js';

export type TurnFinishedTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'ambiguous';
export type TurnFinishedStatus = 'success' | 'error';

const seen = new Set<string>();
const seenOrder: string[] = [];
const SEEN_LIMIT = 4096;

export function turnFinishedStatus(status: TurnFinishedTerminalStatus): TurnFinishedStatus {
  return status === 'completed' ? 'success' : 'error';
}

/** Reply-target sender only. Owner, creator, and last caller are not consulted. */
export function turnFinishedSenderOpenId(
  session: Pick<Session, 'replyTargets' | 'currentReplyTarget' | 'quoteTargetId' | 'quoteTargetSenderOpenId'>,
  turnId: string,
): string | undefined {
  const sender = pickTurnReplyTarget(session, turnId)?.senderOpenId;
  return sender || undefined;
}

export function publishTurnFinished(
  ds: {
    larkAppId: string;
    chatId: string;
    session: Pick<Session, 'sessionId' | 'replyTargets' | 'currentReplyTarget' | 'quoteTargetId' | 'quoteTargetSenderOpenId'>;
  },
  terminal: { turnId: string; dispatchAttempt?: number; status: TurnFinishedTerminalStatus },
): boolean {
  const key = `${ds.session.sessionId}\0${terminal.turnId}\0${terminal.dispatchAttempt ?? ''}`;
  if (seen.has(key)) return false;
  seen.add(key);
  seenOrder.push(key);
  if (seenOrder.length > SEEN_LIMIT) {
    const stale = seenOrder.shift();
    if (stale) seen.delete(stale);
  }
  const senderOpenId = turnFinishedSenderOpenId(ds.session, terminal.turnId);
  const body = {
    sessionId: ds.session.sessionId,
    turnId: terminal.turnId,
    status: turnFinishedStatus(terminal.status),
    larkAppId: ds.larkAppId,
    chatId: ds.chatId,
    ...(terminal.dispatchAttempt !== undefined ? { dispatchAttempt: terminal.dispatchAttempt } : {}),
    ...(senderOpenId ? { senderOpenId } : {}),
  };
  try {
    dashboardEventBus.publish({ type: 'turn.finished', body });
    emitHookEventLocal('turn.finished', body);
    return true;
  } catch (err) {
    seen.delete(key);
    const idx = seenOrder.lastIndexOf(key);
    if (idx >= 0) seenOrder.splice(idx, 1);
    logger.warn(`[turn.finished] publish failed for ${terminal.turnId}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
