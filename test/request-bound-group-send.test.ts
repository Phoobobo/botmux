import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GROUP_SEND_UUID_REUSE_MS,
  groupSendUuid,
  parseGroupSendBody,
  readRequestBoundGroupMessage,
  sendRequestBoundGroupMessage,
} from '../src/services/request-bound-group-send.js';

const APP = 'cli_group_send';
const CHAT = 'oc_group_send';
let dir: string;
let storePath: string;
let clock: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bmx-group-send-'));
  storePath = join(dir, 'group-sends.json');
  clock = 1_700_000_000_000;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const deps = (send: (c: string, t: string, u: string) => Promise<string>) => ({ larkAppId: APP, storePath, send, now: () => clock });
const input = (requestId = 'req_000001', content = 'mosa-checkin abc123') => ({ chatId: CHAT, requestId, content });

describe('parseGroupSendBody', () => {
  it('accepts exactly {requestId, content}', () => {
    expect(parseGroupSendBody({ requestId: 'req_000001', content: 'hi' })).toEqual({ requestId: 'req_000001', content: 'hi' });
    expect(parseGroupSendBody({ requestId: 'req_000001', content: 'hi', extra: 1 })).toBeUndefined();
    expect(parseGroupSendBody({ requestId: 'short', content: 'hi' })).toBeUndefined();
    expect(parseGroupSendBody({ requestId: 'req_000001', content: '   ' })).toBeUndefined();
    expect(parseGroupSendBody({ requestId: 'req_000001', content: 'x'.repeat(8193) })).toBeUndefined();
    expect(parseGroupSendBody([])).toBeUndefined();
  });
});

describe('sendRequestBoundGroupMessage', () => {
  it('sends once with a stable uuid and replays the stored message id', async () => {
    const send = vi.fn(async () => 'om_1');
    const first = await sendRequestBoundGroupMessage(deps(send), input());
    expect(first).toEqual({ ok: true, status: 200, messageId: 'om_1', requestId: 'req_000001', chatId: CHAT, replayed: false });
    expect(send).toHaveBeenCalledWith(CHAT, 'mosa-checkin abc123', groupSendUuid(APP, CHAT, 'req_000001'));
    expect(groupSendUuid(APP, CHAT, 'req_000001').length).toBeLessThanOrEqual(50);
    const again = await sendRequestBoundGroupMessage(deps(send), input());
    expect(again).toMatchObject({ ok: true, messageId: 'om_1', replayed: true });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('serialises concurrent identical requests into one provider call', async () => {
    const send = vi.fn(async () => 'om_c');
    const [a, b] = await Promise.all([sendRequestBoundGroupMessage(deps(send), input()), sendRequestBoundGroupMessage(deps(send), input())]);
    expect(send).toHaveBeenCalledTimes(1);
    expect([a, b].map(r => r.ok && r.messageId)).toEqual(['om_c', 'om_c']);
  });

  it('rejects the same requestId with different content', async () => {
    const send = vi.fn(async () => 'om_1');
    await sendRequestBoundGroupMessage(deps(send), input());
    expect(await sendRequestBoundGroupMessage(deps(send), input('req_000001', 'other'))).toEqual({ ok: false, status: 409, error: 'request_conflict' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps a durable pending record and reuses the uuid only inside the window', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce('om_2');
    expect(await sendRequestBoundGroupMessage(deps(send), input())).toEqual({ ok: false, status: 502, error: 'send_failed', retryable: true });
    const stored = JSON.parse(readFileSync(storePath, 'utf8'));
    expect(Object.values(stored.records)).toMatchObject([{ state: 'pending', requestId: 'req_000001' }]);
    clock += GROUP_SEND_UUID_REUSE_MS - 1;
    expect(await sendRequestBoundGroupMessage(deps(send), input())).toMatchObject({ ok: true, messageId: 'om_2', replayed: true });
    expect(send.mock.calls[0][2]).toBe(send.mock.calls[1][2]);
  });

  it('reports outcome_unknown for a pending record outside the window and never re-sends', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('timeout'));
    await sendRequestBoundGroupMessage(deps(send), input());
    clock += GROUP_SEND_UUID_REUSE_MS + 1;
    expect(await sendRequestBoundGroupMessage(deps(send), input())).toEqual({ ok: false, status: 409, error: 'outcome_unknown', retryable: false });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a corrupt store', async () => {
    writeFileSync(storePath, '{not json');
    const send = vi.fn(async () => 'om_x');
    await expect(sendRequestBoundGroupMessage(deps(send), input())).rejects.toThrow();
    writeFileSync(storePath, JSON.stringify({ schemaVersion: 2, records: {} }));
    await expect(sendRequestBoundGroupMessage(deps(send), input())).rejects.toThrow(/invalid/);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('readRequestBoundGroupMessage', () => {
  const item = (over: Record<string, unknown> = {}) => ({ items: [{
    message_id: 'om_1', chat_id: CHAT, msg_type: 'text', deleted: false, create_time: '1700000000000',
    sender: { id: APP, id_type: 'app_id', sender_type: 'app' }, body: { content: JSON.stringify({ text: 'mosa-checkin abc123' }) }, ...over,
  }] });

  it('reads back sender, text and the bound requestId', async () => {
    await sendRequestBoundGroupMessage(deps(async () => 'om_1'), input());
    const r = await readRequestBoundGroupMessage({ larkAppId: APP, storePath, detail: async () => item() }, CHAT, 'om_1');
    expect(r).toEqual({ ok: true, messageId: 'om_1', chatId: CHAT, deleted: false, msgType: 'text',
      sender: { id: APP, idType: 'app_id', senderType: 'app', isSelf: true }, createTime: '1700000000000',
      text: 'mosa-checkin abc123', requestId: 'req_000001' });
  });

  it('reports deleted, foreign senders and unbound messages honestly', async () => {
    const r = await readRequestBoundGroupMessage({ larkAppId: APP, storePath,
      detail: async () => item({ deleted: true, sender: { id: 'ou_x', id_type: 'open_id', sender_type: 'user' } }) }, CHAT, 'om_1');
    expect(r).toMatchObject({ ok: true, deleted: true, requestId: null, sender: { isSelf: false, senderType: 'user' } });
  });

  it('rejects chat mismatch, missing messages and provider errors', async () => {
    const base = { larkAppId: APP, storePath };
    expect(await readRequestBoundGroupMessage({ ...base, detail: async () => item({ chat_id: 'oc_other' }) }, CHAT, 'om_1')).toEqual({ ok: false, status: 409, error: 'chat_mismatch' });
    expect(await readRequestBoundGroupMessage({ ...base, detail: async () => ({ items: [] }) }, CHAT, 'om_1')).toEqual({ ok: false, status: 404, error: 'not_found' });
    expect(await readRequestBoundGroupMessage({ ...base, detail: async () => { throw new Error('x'); } }, CHAT, 'om_1')).toEqual({ ok: false, status: 502, error: 'read_failed' });
  });
});
