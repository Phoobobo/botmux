import { describe, expect, it } from 'vitest';
import { dashboardEventBus } from '../src/core/dashboard-events.js';
import { publishTurnFinished, turnFinishedSenderOpenId } from '../src/core/turn-finished-event.js';
import type { Session } from '../src/types.js';

function session(extra: Partial<Session> = {}): Session {
  return {
    sessionId: 'sess-1',
    ownerOpenId: 'ou_owner',
    creatorOpenId: 'ou_creator',
    lastCallerOpenId: 'ou_last',
    ...extra,
  } as Session;
}

describe('turn.finished', () => {
  it('uses the reply-target sender and does not fall back to the owner', () => {
    const withSender = session({
      replyTargets: {
        om_turn: { senderOpenId: 'ou_clicker', participants: [{ openId: 'ou_clicker', isBot: false }], updatedAt: 't' },
      },
    });
    expect(turnFinishedSenderOpenId(withSender, 'om_turn')).toBe('ou_clicker');
    expect(turnFinishedSenderOpenId(session(), 'om_turn')).toBeUndefined();
  });

  it('publishes success and error once per turn attempt on the hook bus and SSE bus', () => {
    const seen: Array<{ type: string; body: Record<string, unknown> }> = [];
    const off = dashboardEventBus.subscribe(event => {
      if (event.type === 'turn.finished') seen.push({ type: event.type, body: event.body as Record<string, unknown> });
    });
    const ds = {
      larkAppId: 'cli_app',
      chatId: 'oc_chat',
      session: session({
        sessionId: 'sess-finished',
        replyTargets: {
          om_ok: { senderOpenId: 'ou_sender', participants: [{ openId: 'ou_sender', isBot: false }], updatedAt: 't' },
        },
      }),
    };
    try {
      expect(publishTurnFinished(ds, { turnId: 'om_ok', status: 'completed' })).toBe(true);
      expect(publishTurnFinished(ds, { turnId: 'om_ok', status: 'failed' })).toBe(false);
      expect(publishTurnFinished(ds, { turnId: 'om_bad', status: 'cancelled', dispatchAttempt: 2 })).toBe(true);
      expect(publishTurnFinished(ds, { turnId: 'om_bad', status: 'ambiguous', dispatchAttempt: 3 })).toBe(true);
    } finally {
      off();
    }
    expect(seen.map(event => event.body)).toEqual([
      {
        sessionId: 'sess-finished',
        turnId: 'om_ok',
        status: 'success',
        larkAppId: 'cli_app',
        chatId: 'oc_chat',
        senderOpenId: 'ou_sender',
      },
      {
        sessionId: 'sess-finished',
        turnId: 'om_bad',
        status: 'error',
        larkAppId: 'cli_app',
        chatId: 'oc_chat',
        dispatchAttempt: 2,
      },
      {
        sessionId: 'sess-finished',
        turnId: 'om_bad',
        status: 'error',
        larkAppId: 'cli_app',
        chatId: 'oc_chat',
        dispatchAttempt: 3,
      },
    ]);
    expect(JSON.stringify(seen)).not.toContain('ou_owner');
  });
});
