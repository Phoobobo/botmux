/**
 * Request-bound group send: one caller `requestId` → at most one visible message
 * from this daemon's bot in one chat, with the exact Lark `message_id` returned
 * and an independent read-back of that message.
 *
 * Why: `/api/trigger` returns no message id and `hall-announce` may skip, so an
 * integrator cannot prove that *this* request produced *that* visible message.
 *
 * Dedupe has two layers:
 *  1. A durable per-bot record `${chatId}\u0000${requestId}` → {contentDigest,
 *     uuid, state, messageId}. It is written (fsync) *before* the provider call,
 *     so a crash cannot lose the fact that a send may have happened.
 *  2. The Lark IM `uuid` (≤50 chars, ~1h server-side dedupe) derived from the
 *     record. A retry of a `pending` record inside the window reuses the uuid,
 *     and Lark returns the original message_id instead of sending again.
 *
 * Outside that window a `pending` record is reported as `outcome_unknown` and
 * is never re-sent. The same requestId with different content is a conflict.
 * Corrupt or unreadable state fails closed (it is a dedupe authority).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';

export const GROUP_SEND_REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;
export const GROUP_SEND_CONTENT_MAX_BYTES = 8192;
/** Stay well inside Lark's ~1h uuid dedupe window. */
export const GROUP_SEND_UUID_REUSE_MS = 50 * 60 * 1000;
const RECORD_LIMIT = 2000;

export type GroupSendRecord = {
  chatId: string; requestId: string; contentDigest: string; uuid: string;
  state: 'pending' | 'sent'; firstAttemptAt: number; messageId?: string; sentAt?: number;
};
type StoreFile = { schemaVersion: 1; records: Record<string, GroupSendRecord> };

export type GroupSendDeps = {
  larkAppId: string;
  storePath: string;
  send: (chatId: string, text: string, uuid: string) => Promise<string>;
  now?: () => number;
};
export type GroupSendInput = { chatId: string; requestId: string; content: string };
export type GroupSendResult =
  | { ok: true; status: 200; messageId: string; requestId: string; chatId: string; replayed: boolean }
  | { ok: false; status: 400 | 409 | 502; error: 'invalid_request' | 'request_conflict' | 'outcome_unknown' | 'send_failed'; retryable?: boolean };

export function groupSendUuid(larkAppId: string, chatId: string, requestId: string): string {
  return 'bmxgs-' + createHash('sha256').update(`${larkAppId}\u0000${chatId}\u0000${requestId}`).digest('hex').slice(0, 40);
}
const key = (chatId: string, requestId: string) => `${chatId}\u0000${requestId}`;
const digest = (content: string) => 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex');

function load(path: string): StoreFile {
  if (!existsSync(path)) return { schemaVersion: 1, records: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as StoreFile; // throws → fail closed
  if (!parsed || parsed.schemaVersion !== 1 || typeof parsed.records !== 'object' || parsed.records === null) throw new Error('group send store is invalid');
  return parsed;
}
function save(path: string, file: StoreFile): void {
  const entries = Object.entries(file.records);
  if (entries.length > RECORD_LIMIT) {
    // Drop the oldest *sent* records only; pending ones are dedupe evidence.
    const sent = entries.filter(([, r]) => r.state === 'sent').sort((a, b) => a[1].firstAttemptAt - b[1].firstAttemptAt);
    for (const [k] of sent.slice(0, entries.length - RECORD_LIMIT)) delete file.records[k];
  }
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(path, JSON.stringify(file), { mode: 0o600, durable: true });
}

const queues = new Map<string, Promise<unknown>>();
function serial<T>(name: string, work: () => Promise<T>): Promise<T> {
  const previous = queues.get(name) ?? Promise.resolve();
  const next = previous.then(work, work);
  const tail = next.catch(() => undefined);
  queues.set(name, tail);
  void tail.then(() => { if (queues.get(name) === tail) queues.delete(name); });
  return next;
}

export function parseGroupSendBody(body: unknown): { requestId: string; content: string } | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const keys = Object.keys(body);
  if (keys.length !== 2 || !keys.includes('requestId') || !keys.includes('content')) return undefined;
  const { requestId, content } = body as Record<string, unknown>;
  if (typeof requestId !== 'string' || !GROUP_SEND_REQUEST_ID.test(requestId)) return undefined;
  if (typeof content !== 'string' || !content.trim() || Buffer.byteLength(content, 'utf8') > GROUP_SEND_CONTENT_MAX_BYTES) return undefined;
  return { requestId, content };
}

export async function sendRequestBoundGroupMessage(deps: GroupSendDeps, input: GroupSendInput): Promise<GroupSendResult> {
  if (!input.chatId || !GROUP_SEND_REQUEST_ID.test(input.requestId)) return { ok: false, status: 400, error: 'invalid_request' };
  const now = deps.now ?? Date.now;
  return serial(deps.storePath, async () => {
    const file = load(deps.storePath);
    const k = key(input.chatId, input.requestId), contentDigest = digest(input.content);
    let record = file.records[k];
    if (record && record.contentDigest !== contentDigest) return { ok: false, status: 409, error: 'request_conflict' };
    if (record?.state === 'sent' && record.messageId) {
      return { ok: true, status: 200, messageId: record.messageId, requestId: input.requestId, chatId: input.chatId, replayed: true };
    }
    if (record && now() - record.firstAttemptAt > GROUP_SEND_UUID_REUSE_MS) return { ok: false, status: 409, error: 'outcome_unknown', retryable: false };
    const replayed = !!record;
    if (!record) {
      record = { chatId: input.chatId, requestId: input.requestId, contentDigest,
        uuid: groupSendUuid(deps.larkAppId, input.chatId, input.requestId), state: 'pending', firstAttemptAt: now() };
      file.records[k] = record; save(deps.storePath, file);
    }
    let messageId: string;
    try { messageId = await deps.send(input.chatId, input.content, record.uuid); }
    catch { return { ok: false, status: 502, error: 'send_failed', retryable: true }; }
    if (typeof messageId !== 'string' || !messageId) return { ok: false, status: 502, error: 'send_failed', retryable: true };
    const latest = load(deps.storePath);
    latest.records[k] = { ...record, state: 'sent', messageId, sentAt: now() }; save(deps.storePath, latest);
    return { ok: true, status: 200, messageId, requestId: input.requestId, chatId: input.chatId, replayed };
  });
}

export type GroupMessageReadback = {
  ok: true; messageId: string; chatId: string; deleted: boolean; msgType: string | null;
  sender: { id: string | null; idType: string | null; senderType: string | null; isSelf: boolean };
  createTime: string | null; text: string | null; requestId: string | null;
};
export type GroupReadDeps = {
  larkAppId: string; storePath: string;
  detail: (messageId: string) => Promise<any>;
};

/** Independent read-back. `requestId` is only reported when the durable record binds it to this message. */
export async function readRequestBoundGroupMessage(deps: GroupReadDeps, chatId: string, messageId: string):
  Promise<GroupMessageReadback | { ok: false; status: 404 | 409 | 502; error: 'not_found' | 'chat_mismatch' | 'read_failed' }> {
  let data: any;
  try { data = await deps.detail(messageId); } catch { return { ok: false, status: 502, error: 'read_failed' }; }
  const item = Array.isArray(data?.items) ? data.items.find((m: any) => m?.message_id === messageId) : undefined;
  if (!item) return { ok: false, status: 404, error: 'not_found' };
  if (item.chat_id !== chatId) return { ok: false, status: 409, error: 'chat_mismatch' };
  let text: string | null = null;
  if (item.msg_type === 'text' && typeof item.body?.content === 'string') {
    try { const parsed = JSON.parse(item.body.content); if (typeof parsed?.text === 'string') text = parsed.text; } catch { /* leave null */ }
  }
  let requestId: string | null = null;
  try {
    for (const r of Object.values(load(deps.storePath).records)) if (r.chatId === chatId && r.messageId === messageId) requestId = r.requestId;
  } catch { /* unreadable store: no binding claim */ }
  const sender = item.sender ?? {};
  return { ok: true, messageId, chatId, deleted: item.deleted === true, msgType: typeof item.msg_type === 'string' ? item.msg_type : null,
    sender: { id: typeof sender.id === 'string' ? sender.id : null, idType: typeof sender.id_type === 'string' ? sender.id_type : null,
      senderType: typeof sender.sender_type === 'string' ? sender.sender_type : null,
      isSelf: sender.sender_type === 'app' && sender.id === deps.larkAppId },
    createTime: typeof item.create_time === 'string' ? item.create_time : null, text, requestId };
}
