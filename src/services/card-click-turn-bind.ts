/**
 * Production wiring for a signed card-click turn.
 *
 * The clicker's open_id is the only turn sender. This file never reads
 * getOwnerOpenId, and it never copies the session owner or creator into the
 * caller or the reply-target sender.
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getBot } from '../bot-registry.js';
import { loadOrCreateDashboardSecret } from '../dashboard/auth.js';
import { localeForBot } from '../i18n/index.js';
import { canOperate, evaluateTalk, grantCommandRestriction, isKnownPeerBot } from '../im/lark/event-dispatcher.js';
import { getIdentity, resolveSender } from '../im/lark/identity-cache.js';
import { sendMessage } from '../im/lark/client.js';
import { extractLarkBusinessCode } from '../im/lark/lark-errors.js';
import { beginReplyTargetTurn } from '../core/reply-target.js';
import { sessionKey, type DaemonSession } from '../core/types.js';
import { sessionPromptInjection } from '../core/prompt-injection.js';
import { markSessionActivity } from '../core/session-activity.js';
import { buildFollowUpCliInput, buildNewTopicCliInput, rememberLastCliInput } from '../core/session-manager.js';
import { forkWorker, getCurrentCliVersion, sendWorkerInput, withActiveSessionKeyLock } from '../core/worker-pool.js';
import { ensureQueue } from './message-queue.js';
import * as sessionStore from './session-store.js';
import { logger } from '../utils/logger.js';
import {
  buildCardClickTurnCard,
  CardClickNonceStore,
  issueCardClickTurn,
  parseCardClickTurnPost,
  type CardClickTurnClaims,
} from './card-click-turn.js';
import {
  acceptCardClickTurn,
  type CardClickBoundSession,
  type CardClickTurnRuntimeDeps,
} from './card-click-turn-runtime.js';
import type { TrustedCaller } from '../types.js';

const BOT_NOT_IN_CHAT = 230002;

export interface CardClickTurnBinderDeps {
  activeSessions: Map<string, DaemonSession>;
  /** Read at use time so a startup override of the session data dir is visible. */
  dataDir(): string;
  noteTurnReceived: (
    ds: DaemonSession,
    triggerMessageId: string,
    prompt: string | undefined,
    sender: { name?: string } | undefined,
    turnId: string,
  ) => Promise<void>;
  beginNewTurn: (ds: DaemonSession, title: string, turnId: string) => void;
  trustedCallerForInboundTurn: (
    larkAppId: string,
    senderOpenId: string,
    senderUnionId: string | undefined,
  ) => Promise<TrustedCaller | undefined>;
}

function boundFrom(ds: DaemonSession): CardClickBoundSession {
  return {
    sessionId: ds.session.sessionId,
    chatId: ds.chatId,
    chatType: ds.chatType,
    workingDir: ds.workingDir ?? ds.session.workingDir,
    live: ds,
  };
}

function liveSession(session: CardClickBoundSession): DaemonSession {
  return session.live as DaemonSession;
}

function directoryReady(dir: string): boolean {
  try { return existsSync(dir) && statSync(dir).isDirectory(); } catch { return false; }
}

export function cardClickOperatorIsBotOrApp(dataDir: string, larkAppId: string, openId: string): boolean {
  if (isKnownPeerBot(dataDir, larkAppId, openId)) return true;
  const cached = getIdentity(larkAppId, openId);
  return cached?.type === 'bot' || cached?.type === 'app';
}

export function createCardClickTurnBinder(deps: CardClickTurnBinderDeps) {
  let nonces: CardClickNonceStore | undefined;
  const nonceStore = () => {
    nonces ??= CardClickNonceStore.open(join(deps.dataDir(), 'card-click-turn-nonces.json'));
    return nonces;
  };
  const secret = () => loadOrCreateDashboardSecret(join(deps.dataDir(), 'card-click-turn.secret'));

  function findSession(larkAppId: string, claims: CardClickTurnClaims): CardClickBoundSession | undefined {
    if (claims.sessionId) {
      for (const ds of deps.activeSessions.values()) {
        if (ds.session.sessionId === claims.sessionId && ds.larkAppId === larkAppId) return boundFrom(ds);
      }
      return undefined;
    }
    if (!claims.chatId) return undefined;
    const ds = deps.activeSessions.get(sessionKey(claims.chatId, larkAppId));
    return ds ? boundFrom(ds) : undefined;
  }

  async function createSession(
    larkAppId: string,
    claims: CardClickTurnClaims,
    senderOpenId: string,
    chatType: 'group' | 'p2p',
  ): Promise<{ ok: true; session: CardClickBoundSession } | { ok: false; reason: string }> {
    if (!claims.chatId || !claims.workingDir) return { ok: false, reason: 'working_dir_required' };
    const key = sessionKey(claims.chatId, larkAppId);
    const registered = await withActiveSessionKeyLock(deps.activeSessions, key, async () => {
      const current = deps.activeSessions.get(key);
      if (current) return { ds: current, created: false };
      const title = claims.prompt.replace(/\s+/g, ' ').slice(0, 40) || 'card click';
      const session = sessionStore.createSession(claims.chatId!, claims.chatId!, title, chatType, 'chat');
      const now = Date.now();
      session.larkAppId = larkAppId;
      session.scope = 'chat';
      session.ownerOpenId = senderOpenId;
      session.creatorOpenId = senderOpenId;
      session.workingDir = claims.workingDir;
      session.lastMessageAt = new Date(now).toISOString();
      sessionStore.updateSession(session);
      ensureQueue(claims.chatId!);
      const ds: DaemonSession = {
        session,
        worker: null,
        workerPort: null,
        workerToken: null,
        larkAppId,
        chatId: claims.chatId!,
        chatType,
        scope: 'chat',
        spawnedAt: now,
        cliVersion: getCurrentCliVersion(),
        lastMessageAt: now,
        hasHistory: false,
        workingDir: claims.workingDir,
        ownerOpenId: senderOpenId,
      };
      deps.activeSessions.set(key, ds);
      return { ds, created: true };
    });
    if (!registered) return { ok: false, reason: 'delivery_failed' };
    const existingDir = registered.ds.workingDir ?? registered.ds.session.workingDir;
    if (!registered.created && claims.workingDir && existingDir && existingDir !== claims.workingDir) {
      return { ok: false, reason: 'working_dir_mismatch' };
    }
    return { ok: true, session: boundFrom(registered.ds) };
  }

  async function startTurn(
    session: CardClickBoundSession,
    args: { senderOpenId: string; memberUnionId?: string; prompt: string },
  ): Promise<{ ok: true; turnId: string } | { ok: false; reason: string }> {
    const ds = liveSession(session);
    const senderOpenId = args.senderOpenId;
    const trustedCaller = await deps.trustedCallerForInboundTurn(ds.larkAppId, senderOpenId, args.memberUnionId);
    if (!trustedCaller || trustedCaller.senderType !== 'user' || trustedCaller.requestUserOpenId !== senderOpenId) {
      return { ok: false, reason: 'delivery_failed' };
    }
    const turnId = `cct_${randomUUID()}`;
    const sender = await resolveSender(ds.larkAppId, senderOpenId, 'user');
    ds.session.quoteTargetId = turnId;
    ds.session.quoteTargetSenderOpenId = senderOpenId;
    ds.session.quoteTargetSenderIsBot = false;
    beginReplyTargetTurn(ds, ds.scope === 'thread' ? ds.session.rootMessageId : undefined, turnId, new Date().toISOString(), {
      senderOpenId,
      participants: [{ openId: senderOpenId, isBot: false }],
      inThread: ds.scope === 'thread',
    });
    const bot = getBot(ds.larkAppId);
    const cliId = ds.session.cliLaunchSnapshot?.cliId ?? ds.session.cliId ?? bot.config.cliId;
    const opening = !ds.hasHistory && (!ds.worker || ds.worker.killed);
    const input = opening
      ? buildNewTopicCliInput(
        args.prompt, ds.session.sessionId, cliId, undefined, undefined, undefined, undefined, undefined,
        { name: bot.botName, openId: bot.botOpenId }, localeForBot(ds.larkAppId), sender,
        {
          promptInjection: sessionPromptInjection(ds),
          larkAppId: ds.larkAppId,
          chatId: ds.chatId,
          turnId,
          trustedCaller,
          sessionBackendType: ds.session.backendType,
          selfMention: { name: bot.botName, openId: bot.botOpenId },
        },
      )
      : buildFollowUpCliInput(args.prompt, ds.session.sessionId, {
        cliId,
        sender,
        turnId,
        larkAppId: ds.larkAppId,
        chatId: ds.chatId,
        selfMention: { name: bot.botName, openId: bot.botOpenId },
        sessionBackendType: ds.session.backendType,
        promptInjection: sessionPromptInjection(ds),
        trustedCaller,
      });
    await deps.noteTurnReceived(ds, turnId, args.prompt, sender, turnId);
    ds.activeInteractiveTurn = {
      turnId,
      caller: { ...trustedCaller },
      userPrompt: args.prompt,
    };
    const live = !!ds.worker && !ds.worker.killed;
    const sent = live
      ? sendWorkerInput(ds, input, turnId, { trustedCaller })
      : forkWorker(ds, input, { resume: ds.hasHistory, turnId, trustedCaller });
    if (!sent) return { ok: false, reason: 'delivery_failed' };
    try { deps.beginNewTurn(ds, args.prompt, turnId); } catch (err) {
      logger.warn(`[card-click-turn] beginNewTurn failed for ${turnId}: ${err instanceof Error ? err.message : String(err)}`);
    }
    rememberLastCliInput(ds, args.prompt, input);
    markSessionActivity(ds, Date.now(), { human: true });
    sessionStore.updateSession(ds.session);
    logger.info(`[card-click-turn] ${ds.session.sessionId.slice(0, 8)} turn ${turnId} sender=${senderOpenId}`);
    return { ok: true, turnId };
  }

  const runtimeDeps = (): CardClickTurnRuntimeDeps => ({
    now: () => Date.now(),
    secret,
    nonces: { consume: (nonce, exp, now) => nonceStore().consume(nonce, exp, now) },
    isBotOrApp: (larkAppId, openId) => cardClickOperatorIsBotOrApp(deps.dataDir(), larkAppId, openId),
    evaluateTalk: (larkAppId, chatId, openId, chatType, unionId) =>
      evaluateTalk(larkAppId, chatId, openId, undefined, unionId, chatType),
    canOperate: (larkAppId, chatId, openId) => canOperate(larkAppId, chatId, openId),
    grantCommandRestriction: (larkAppId, chatId, openId) => grantCommandRestriction(larkAppId, chatId, openId),
    findSession,
    createSession,
    workingDirReady: directoryReady,
    setWorkingDir: (session, dir) => {
      const ds = liveSession(session);
      ds.workingDir = dir;
      ds.session.workingDir = dir;
      sessionStore.updateSession(ds.session);
    },
    startTurn,
  });

  return {
    accept(input: {
      larkAppId: string;
      operatorOpenId?: string;
      operatorUnionId?: string;
      payload?: string;
      sig?: string;
    }) {
      return acceptCardClickTurn(input, runtimeDeps());
    },
    async post(larkAppId: string, body: unknown): Promise<
      | { ok: true; messageId: string; exp: number }
      | { ok: false; status: number; error: string }
    > {
      const parsed = parseCardClickTurnPost(body);
      if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
      if (parsed.workingDir && !directoryReady(parsed.workingDir)) {
        return { ok: false, status: 400, error: 'working_dir_missing' };
      }
      let issued: ReturnType<typeof issueCardClickTurn>;
      try {
        issued = issueCardClickTurn({
          secret: secret(),
          larkAppId,
          prompt: parsed.prompt,
          chatId: parsed.chatId,
          sessionId: parsed.sessionId,
          workingDir: parsed.workingDir,
          chatType: parsed.chatType,
          ttlMs: parsed.ttlMs,
        });
      } catch (err) {
        logger.warn(`[card-click-turn] secret unavailable: ${err instanceof Error ? err.message : String(err)}`);
        return { ok: false, status: 503, error: 'secret_unavailable' };
      }
      if (!issued.ok) return { ok: false, status: 400, error: issued.error };
      const locale = localeForBot(larkAppId);
      const card = buildCardClickTurnCard({
        title: parsed.title ?? (locale === 'en' ? 'Start a turn' : '发起一轮对话'),
        prompt: issued.claims.prompt,
        buttonLabel: parsed.buttonLabel ?? (locale === 'en' ? 'Start' : '开始'),
        payload: issued.payload,
        sig: issued.sig,
      });
      try {
        const messageId = await sendMessage(larkAppId, parsed.postChatId, JSON.stringify(card), 'interactive');
        return { ok: true, messageId, exp: issued.claims.exp };
      } catch (err) {
        if (extractLarkBusinessCode(err) === BOT_NOT_IN_CHAT) {
          return { ok: false, status: 403, error: 'bot_not_in_chat' };
        }
        logger.warn(`[card-click-turn] post failed: ${err instanceof Error ? err.message : String(err)}`);
        return { ok: false, status: 502, error: 'send_failed' };
      }
    },
  };
}
