import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CARD_CLICK_TURN_ACTION,
  CardClickNonceStore,
  admitCardClickSender,
  buildCardClickTurnCard,
  issueCardClickTurn,
  parseCardClickTurnPost,
  readCardClickTurnClaims,
} from '../src/services/card-click-turn.js';
import {
  acceptCardClickTurn,
  type CardClickBoundSession,
  type CardClickTurnRuntimeDeps,
} from '../src/services/card-click-turn-runtime.js';

const SECRET = 'test-secret';
const APP = 'cli_app';
const NOW = 1_700_000_000_000;

function issue(overrides: Partial<Parameters<typeof issueCardClickTurn>[0]> = {}) {
  const issued = issueCardClickTurn({
    secret: SECRET,
    larkAppId: APP,
    prompt: 'do the thing',
    chatId: 'oc_chat',
    workingDir: '/tmp',
    now: NOW,
    nonce: 'nonce-nonce-nonce',
    ...overrides,
  });
  if (!issued.ok) throw new Error(issued.error);
  return issued;
}

describe('card click turn token', () => {
  it('round-trips a signed payload and rejects tampering', () => {
    const issued = issue();
    expect(readCardClickTurnClaims(issued.payload, issued.sig, SECRET, NOW).ok).toBe(true);
    const tampered = issued.payload.replace('do the thing', 'do something else');
    expect(readCardClickTurnClaims(tampered, issued.sig, SECRET, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(readCardClickTurnClaims(issued.payload, issued.sig, 'other-secret', NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects an expired token before a caller could treat it as a replay', () => {
    const issued = issue({ ttlMs: 60_000 });
    expect(readCardClickTurnClaims(issued.payload, issued.sig, SECRET, issued.claims.exp)).toEqual({ ok: false, reason: 'expired' });
    const store = CardClickNonceStore.open();
    expect(store.consume(issued.claims.nonce, issued.claims.exp, NOW)).toBe('ok');
  });

  it('persists a consumed nonce across a new store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'card-click-nonce-'));
    const now = Date.now();
    try {
      const file = join(dir, 'nonces.json');
      const first = CardClickNonceStore.open(file);
      expect(first.consume('nonce-nonce-nonce', now + 60_000, now)).toBe('ok');
      const second = CardClickNonceStore.open(file);
      expect(second.consume('nonce-nonce-nonce', now + 60_000, now)).toBe('replayed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires exactly one target and an absolute working directory', () => {
    expect(issueCardClickTurn({ secret: SECRET, larkAppId: APP, prompt: 'x', now: NOW }).ok).toBe(false);
    expect(issueCardClickTurn({
      secret: SECRET, larkAppId: APP, prompt: 'x', chatId: 'oc_a', sessionId: '12345678-1234-1234-1234-123456789012', now: NOW,
    }).ok).toBe(false);
    expect(issueCardClickTurn({
      secret: SECRET, larkAppId: APP, prompt: 'x', chatId: 'oc_a', workingDir: 'relative', now: NOW,
    }).ok).toBe(false);
    expect(issueCardClickTurn({
      secret: SECRET, larkAppId: APP, prompt: 'x', chatId: 'oc_a', workingDir: '/tmp/../etc', now: NOW,
    }).ok).toBe(false);
  });

  it('builds a callback button that carries the signed payload', () => {
    const issued = issue();
    const card = buildCardClickTurnCard({
      title: '发起一轮对话', prompt: issued.claims.prompt, buttonLabel: '开始', payload: issued.payload, sig: issued.sig,
    });
    const elements = card.elements as Array<{ tag: string; actions?: Array<{ value: Record<string, string> }> }>;
    const button = elements.find(el => el.tag === 'action')?.actions?.[0];
    expect(button?.value).toEqual({ action: CARD_CLICK_TURN_ACTION, payload: issued.payload, sig: issued.sig });
  });

  it('parses a post body without inventing a second target', () => {
    expect(parseCardClickTurnPost({ prompt: ' hi ', sessionId: '12345678-abcd-abcd-abcd-1234567890ab', postChatId: 'oc_post' })).toMatchObject({
      ok: true, prompt: ' hi ', sessionId: '12345678-abcd-abcd-abcd-1234567890ab', postChatId: 'oc_post',
    });
    expect(parseCardClickTurnPost({ prompt: 'hi', sessionId: '12345678-abcd-abcd-abcd-1234567890ab' })).toEqual({ ok: false, error: 'invalid_post_chat' });
    expect(parseCardClickTurnPost({ prompt: 'hi', chatId: 'oc_a', sessionId: '12345678-abcd-abcd-abcd-1234567890ab' })).toEqual({ ok: false, error: 'target_required' });
  });
});

describe('admitCardClickSender', () => {
  const base = { openId: 'ou_clicker', isBotOrApp: false, talk: { allowed: true, reason: 'allowedUser' }, canOperate: true, grantBlocked: false };

  it('never accepts a missing or bot identity', () => {
    expect(admitCardClickSender({ ...base, openId: undefined }).reason).toBe('no_identity');
    expect(admitCardClickSender({ ...base, isBotOrApp: true }).reason).toBe('bot_or_app');
  });

  it('requires talk, operate, and the grant-command gate', () => {
    expect(admitCardClickSender({ ...base, talk: { allowed: false, reason: 'blocked' } }).reason).toBe('blocked');
    expect(admitCardClickSender({ ...base, talk: { allowed: false, reason: 'none' } }).reason).toBe('not_allowed');
    expect(admitCardClickSender({ ...base, grantBlocked: true }).reason).toBe('grant_blocked');
    expect(admitCardClickSender({ ...base, canOperate: false }).reason).toBe('cannot_operate');
    expect(admitCardClickSender(base)).toEqual({ ok: true, senderOpenId: 'ou_clicker' });
  });
});

describe('acceptCardClickTurn', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function harness(overrides: Partial<CardClickTurnRuntimeDeps> = {}) {
    const started: Array<{ senderOpenId: string; prompt: string; session: CardClickBoundSession }> = [];
    const created: Array<{ senderOpenId: string; chatType: string }> = [];
    const sessions = new Map<string, CardClickBoundSession>();
    const deps: CardClickTurnRuntimeDeps = {
      now: () => NOW,
      secret: () => SECRET,
      nonces: CardClickNonceStore.open(),
      isBotOrApp: () => false,
      evaluateTalk: () => ({ allowed: true, reason: 'allowedUser' }),
      canOperate: () => true,
      grantCommandRestriction: () => ({ blocked: false }),
      findSession: (_app, claims) => sessions.get(claims.sessionId ?? claims.chatId ?? ''),
      createSession: async (_app, _claims, senderOpenId, chatType) => {
        created.push({ senderOpenId, chatType });
        const session: CardClickBoundSession = {
          sessionId: 'created-session-id-0001',
          chatId: 'oc_chat',
          chatType,
          workingDir: '/tmp',
          live: { ownerOpenId: 'ou_owner', creatorOpenId: 'ou_creator' },
        };
        return { ok: true, session };
      },
      workingDirReady: dir => dir === '/tmp',
      setWorkingDir: (session, dir) => { session.workingDir = dir; },
      startTurn: async (session, args) => {
        started.push({ senderOpenId: args.senderOpenId, prompt: args.prompt, session });
        return { ok: true, turnId: 'cct_test' };
      },
      ...overrides,
    };
    return { deps, started, created, sessions };
  }

  it('starts the turn as the clicker and does not read the session owner', async () => {
    const { deps, started, sessions } = harness();
    sessions.set('sess-id-1', {
      sessionId: 'sess-id-1',
      chatId: 'oc_chat',
      chatType: 'group',
      workingDir: '/tmp',
      live: { ownerOpenId: 'ou_owner', creatorOpenId: 'ou_creator' },
    });
    const issued = issue({ chatId: undefined, sessionId: 'sess-id-1', workingDir: undefined });
    const accepted = await acceptCardClickTurn({
      larkAppId: APP, operatorOpenId: 'ou_clicker', payload: issued.payload, sig: issued.sig,
    }, deps);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    await accepted.run();
    expect(started.map(call => ({ senderOpenId: call.senderOpenId, prompt: call.prompt }))).toEqual([{
      senderOpenId: 'ou_clicker',
      prompt: 'do the thing',
    }]);
    expect(started[0]?.session.live).toEqual({ ownerOpenId: 'ou_owner', creatorOpenId: 'ou_creator' });
  });

  it('does not start a turn or create a session for a bot or app clicker', async () => {
    const { deps, started, created } = harness({ isBotOrApp: () => true });
    const issued = issue();
    const accepted = await acceptCardClickTurn({
      larkAppId: APP, operatorOpenId: 'ou_bot', payload: issued.payload, sig: issued.sig,
    }, deps);
    expect(accepted).toEqual({ ok: false, reason: 'bot_or_app' });
    expect(started).toEqual([]);
    expect(created).toEqual([]);
  });

  it('refuses a missing session id instead of spawning another session', async () => {
    const { deps, created } = harness();
    const issued = issue({ chatId: undefined, sessionId: 'missing-session-id', workingDir: undefined });
    const accepted = await acceptCardClickTurn({
      larkAppId: APP, operatorOpenId: 'ou_clicker', payload: issued.payload, sig: issued.sig,
    }, deps);
    expect(accepted).toEqual({ ok: false, reason: 'session_not_found' });
    expect(created).toEqual([]);
  });

  it('creates a chat session owned by the clicker', async () => {
    const { deps, created, started } = harness();
    const issued = issue({ chatType: 'p2p' });
    const accepted = await acceptCardClickTurn({
      larkAppId: APP, operatorOpenId: 'ou_clicker', operatorUnionId: 'on_clicker', payload: issued.payload, sig: issued.sig,
    }, deps);
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    await accepted.run();
    expect(created).toEqual([{ senderOpenId: 'ou_clicker', chatType: 'p2p' }]);
    expect(started[0]?.senderOpenId).toBe('ou_clicker');
  });

  it('rejects a second click of the same button', async () => {
    const { deps, started } = harness();
    const issued = issue();
    const first = await acceptCardClickTurn({
      larkAppId: APP, operatorOpenId: 'ou_clicker', payload: issued.payload, sig: issued.sig,
    }, deps);
    expect(first.ok).toBe(true);
    const second = await acceptCardClickTurn({
      larkAppId: APP, operatorOpenId: 'ou_clicker', payload: issued.payload, sig: issued.sig,
    }, deps);
    expect(second).toEqual({ ok: false, reason: 'replayed' });
    expect(started).toEqual([]);
  });

  it('does not consume an expired token', async () => {
    const consumed = vi.fn(() => 'ok' as const);
    const { deps } = harness({ now: () => NOW + 3_600_000, nonces: { consume: consumed } });
    const issued = issue({ ttlMs: 60_000 });
    const accepted = await acceptCardClickTurn({
      larkAppId: APP, operatorOpenId: 'ou_clicker', payload: issued.payload, sig: issued.sig,
    }, deps);
    expect(accepted).toEqual({ ok: false, reason: 'expired' });
    expect(consumed).not.toHaveBeenCalled();
  });

  it('rejects a working directory that does not match the session', async () => {
    const { deps, started } = harness();
    const sessions = new Map<string, CardClickBoundSession>();
    sessions.set('oc_chat', {
      sessionId: 'sess', chatId: 'oc_chat', chatType: 'group', workingDir: '/tmp', live: {},
    });
    deps.findSession = (_app, claims) => sessions.get(claims.chatId ?? '');
    const issued = issue({ workingDir: '/tmp' });
    const rewritten = issueCardClickTurn({
      secret: SECRET, larkAppId: APP, prompt: 'do the thing', chatId: 'oc_chat', workingDir: '/var', now: NOW, nonce: 'other-nonce-nonce',
    });
    expect(rewritten.ok).toBe(true);
    if (!rewritten.ok) return;
    deps.workingDirReady = () => true;
    const accepted = await acceptCardClickTurn({
      larkAppId: APP, operatorOpenId: 'ou_clicker', payload: rewritten.payload, sig: rewritten.sig,
    }, deps);
    expect(accepted).toEqual({ ok: false, reason: 'working_dir_mismatch' });
    expect(started).toEqual([]);
    expect(issued.ok).toBe(true);
  });

  it('applies talk, operate, and grant checks against the target chat', async () => {
    const talk = vi.fn(() => ({ allowed: true, reason: 'globalGrant' }));
    const operate = vi.fn(() => true);
    const grant = vi.fn(() => ({ blocked: true }));
    const { deps, started } = harness({
      evaluateTalk: talk,
      canOperate: operate,
      grantCommandRestriction: grant,
    });
    const issued = issue();
    const accepted = await acceptCardClickTurn({
      larkAppId: APP, operatorOpenId: 'ou_clicker', operatorUnionId: 'on_member', payload: issued.payload, sig: issued.sig,
    }, deps);
    expect(accepted).toEqual({ ok: false, reason: 'grant_blocked' });
    expect(talk).toHaveBeenCalledWith(APP, 'oc_chat', 'ou_clicker', 'group', 'on_member');
    expect(operate).toHaveBeenCalledWith(APP, 'oc_chat', 'ou_clicker');
    expect(grant).toHaveBeenCalledWith(APP, 'oc_chat', 'ou_clicker');
    expect(started).toEqual([]);
  });
});
