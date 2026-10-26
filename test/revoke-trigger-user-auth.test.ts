/**
 * Revoking one member's trigger-user credentials.
 *
 * The properties pinned here:
 *   1. one person's CLI homes and per-app user token go away; another person's
 *      do not, and neither do unattributed legacy token files or issuer homes;
 *   2. server-side logout runs only when a HOME already exists, and a failed
 *      logout still deletes the local state;
 *   3. a revoked HOME is not treated as logged-in just because the CLI says so;
 *   4. an in-flight refresh or OAuth callback cannot write the token back;
 *   5. published per-turn identities for that person are dropped;
 *   6. the dashboard IPC route is bound-bot scoped and does not echo secrets.
 *
 * Run: bun run vitest run --project unit test/revoke-trigger-user-auth.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const spawns: Array<{ cmd: string; args: string[]; home?: string; homeExisted: boolean }> = [];
let failSpawn = false;

vi.mock('node:child_process', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:child_process')>();
  const { existsSync: homeExists } = await import('node:fs');
  return {
    ...orig,
    spawn: vi.fn((cmd: string, args: string[], opts: { env?: Record<string, string> }) => {
      const home = opts?.env?.HOME;
      spawns.push({ cmd, args: [...args], home, homeExisted: !!home && homeExists(home) });
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter; stderr: EventEmitter; kill: () => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      setImmediate(() => {
        child.stdout.emit('data', '{"ok":true,"status":"success","data":{"authenticated":true}}\n');
        child.emit('close', failSpawn ? 1 : 0);
      });
      return child;
    }),
  };
});

let homeDir = '';
vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => homeDir };
});

const APP = 'cli_revokeapp0001';
const ALICE = 'ou_aliceauth000000000001';
const BOB = 'ou_bobauth000000000002';
const ALICE_SECRET = 'SECRET_ALICE_TOKEN';
const BOB_SECRET = 'SECRET_BOB_TOKEN';

function token(openId: string, access: string, expired = false) {
  return JSON.stringify({
    access_token: access,
    refresh_token: `rt-${access}`,
    token_type: 'Bearer',
    expires_at: new Date(Date.now() + (expired ? -120_000 : 3_600_000)).toISOString(),
    refresh_expires_at: new Date(Date.now() + 86_400_000).toISOString(),
    scope: 'offline_access',
    appId: APP,
    brand: 'feishu',
    openId,
  });
}

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'botmux-revoke-'));
  spawns.length = 0;
  failSpawn = false;
  vi.resetModules();
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(homeDir, { recursive: true, force: true });
});

async function loadRevoke() {
  const revoke = await import('../src/services/revoke-trigger-user-auth.js');
  const byted = await import('../src/services/bytedcli-auth.js');
  const tokens = await import('../src/utils/user-token.js');
  const identity = await import('../src/core/cli-identity.js');
  return { revoke, byted, tokens, identity };
}

function dataDir() {
  return join(homeDir, '.botmux', 'data');
}

function plantStores() {
  const data = dataDir();
  for (const dir of [
    join(data, 'bytedcli-home', ALICE),
    join(data, 'lark-cli-home', ALICE),
    join(data, 'bytedcli-home', BOB),
    join(data, 'lark-cli-home', BOB),
    join(data, `lark-cli-issuer-${ALICE}`),
  ]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'marker'), 'keep-or-drop');
  }
  writeFileSync(join(data, `user-token-${APP}-${ALICE}.json`), token(ALICE, ALICE_SECRET));
  writeFileSync(join(data, `user-token-${APP}-${BOB}.json`), token(BOB, BOB_SECRET));
  writeFileSync(join(data, `user-token-${APP}.json`), JSON.stringify({ access_token: 'LEGACY_APP' }));
  writeFileSync(join(data, 'user-token.json'), JSON.stringify({ access_token: 'LEGACY_SINGLE' }));
}

describe('revokeTriggerUserAuth', () => {
  it('logs out then deletes only that person, and a second call is a no-op success', async () => {
    plantStores();
    const { revoke } = await loadRevoke();
    const sessionDataDir = join(homeDir, 'sessions');
    mkdirSync(sessionDataDir);
    const first = await revoke.revokeTriggerUserAuth({
      openId: ALICE, appId: APP, brand: 'feishu', sessionDataDir,
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.removed).toEqual({ larkCli: true, bytedcli: true, userToken: true });
    expect(first.remoteLogout).toEqual({ larkCli: 'ok', bytedcli: 'ok' });
    expect(spawns.map(s => s.cmd)).toEqual(['lark-cli', 'bytedcli']);
    expect(spawns.every(s => s.homeExisted && s.args.join(' ') === 'auth logout --json')).toBe(true);

    const data = dataDir();
    expect(existsSync(join(data, 'bytedcli-home', ALICE))).toBe(false);
    expect(existsSync(join(data, 'lark-cli-home', ALICE))).toBe(false);
    expect(existsSync(join(data, 'bytedcli-home', BOB))).toBe(true);
    expect(existsSync(join(data, 'lark-cli-home', BOB))).toBe(true);
    expect(existsSync(join(data, `lark-cli-issuer-${ALICE}`, 'marker'))).toBe(true);
    expect(existsSync(join(data, `user-token-${APP}-${ALICE}.json`))).toBe(false);
    expect(readFileSync(join(data, `user-token-${APP}-${BOB}.json`), 'utf8')).toContain(BOB_SECRET);
    expect(readFileSync(join(data, `user-token-${APP}.json`), 'utf8')).toContain('LEGACY_APP');
    expect(readFileSync(join(data, 'user-token.json'), 'utf8')).toContain('LEGACY_SINGLE');

    const second = await revoke.revokeTriggerUserAuth({
      openId: ALICE, appId: APP, brand: 'feishu', sessionDataDir,
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.removed).toEqual({ larkCli: false, bytedcli: false, userToken: false });
    expect(existsSync(join(data, 'bytedcli-home', BOB))).toBe(true);
  });

  it('still deletes local state when the CLI logout fails', async () => {
    plantStores();
    failSpawn = true;
    const { revoke } = await loadRevoke();
    const result = await revoke.revokeTriggerUserAuth({
      openId: ALICE, appId: APP, brand: 'feishu', sessionDataDir: join(homeDir, 'sessions'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.remoteLogout).toEqual({ larkCli: 'failed', bytedcli: 'failed' });
    expect(result.removed.larkCli).toBe(true);
    expect(result.removed.bytedcli).toBe(true);
    expect(existsSync(join(dataDir(), 'lark-cli-home', ALICE))).toBe(false);
  });

  it('does not create a HOME just to log out', async () => {
    const { revoke } = await loadRevoke();
    const result = await revoke.revokeTriggerUserAuth({
      openId: ALICE, appId: APP, brand: 'feishu', sessionDataDir: join(homeDir, 'sessions'),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.remoteLogout).toEqual({ larkCli: 'skipped', bytedcli: 'skipped' });
    expect(spawns).toEqual([]);
    expect(existsSync(join(dataDir(), 'bytedcli-home', ALICE))).toBe(false);
    expect(existsSync(join(dataDir(), 'lark-cli-home', ALICE))).toBe(false);
  });

  it('rejects a path-shaped open id without touching storage', async () => {
    plantStores();
    const { revoke } = await loadRevoke();
    const result = await revoke.revokeTriggerUserAuth({
      openId: '../x', appId: APP, brand: 'feishu', sessionDataDir: join(homeDir, 'sessions'),
    });
    expect(result).toEqual({ ok: false, error: 'invalid_open_id' });
    expect(spawns).toEqual([]);
    expect(existsSync(join(dataDir(), 'bytedcli-home', ALICE))).toBe(true);
    expect(existsSync(join(dataDir(), `user-token-${APP}-${ALICE}.json`))).toBe(true);
  });

  it('ignores a HOME recreated after revoke even when the CLI reports authenticated', async () => {
    plantStores();
    const { revoke, byted } = await loadRevoke();
    await revoke.revokeTriggerUserAuth({
      openId: ALICE, appId: APP, brand: 'feishu', sessionDataDir: join(homeDir, 'sessions'),
    });
    const home = byted.bytedcliHomeFor(ALICE);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'session'), 'rewritten-by-cli');
    spawns.length = 0;
    expect(await byted.hasBytedcliHome(ALICE)).toBe(false);
    expect(existsSync(join(home, 'session'))).toBe(true);
    expect(spawns).toEqual([]);
  });
});

describe('in-flight credential writes after revoke', () => {
  it('does not resurrect a user token when refresh finishes after clear', async () => {
    const { tokens } = await loadRevoke();
    const path = join(dataDir(), `user-token-${APP}-${ALICE}.json`);
    mkdirSync(dataDir(), { recursive: true });
    writeFileSync(path, token(ALICE, ALICE_SECRET, true));

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    vi.stubGlobal('fetch', vi.fn(async () => {
      entered = true;
      await gate;
      return {
        ok: true,
        json: async () => ({
          access_token: 'SHOULD_NOT_LAND',
          refresh_token: 'RT_NEW',
          token_type: 'Bearer',
          expires_in: 7200,
          refresh_token_expires_in: 604800,
          scope: 'offline_access',
        }),
      };
    }));

    const pending = tokens.resolveUserToken(APP, 'sec', 'feishu', ALICE);
    for (let i = 0; i < 50 && !entered; i += 1) await new Promise(resolve => setImmediate(resolve));
    expect(entered).toBe(true);
    expect(tokens.clearUserToken(APP, 'feishu', ALICE)).toBe(true);
    release();
    expect(await pending).toBeNull();
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(join(dataDir(), `user-token-epoch-${APP}-${ALICE}`), 'utf8').trim()).not.toBe('0');
  });

  it('drops an in-flight OAuth callback, then accepts a login started after revoke', async () => {
    const { tokens } = await loadRevoke();
    mkdirSync(dataDir(), { recursive: true });
    const first = tokens.generateAuthUrl(APP, 'sec', 'feishu', [], ALICE);
    const oldState = new URL(first.authUrl).searchParams.get('state');
    expect(tokens.clearUserToken(APP, 'feishu', ALICE)).toBe(false);

    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/oauth/token')) {
        return {
          ok: true,
          json: async () => ({
            access_token: ALICE_SECRET,
            refresh_token: 'RT_NEW',
            token_type: 'Bearer',
            expires_in: 7200,
            refresh_token_expires_in: 604800,
            scope: 'im:message:readonly im:resource offline_access',
          }),
        };
      }
      return { ok: true, json: async () => ({ code: 0, data: { open_id: ALICE } }) };
    }));

    const path = join(dataDir(), `user-token-${APP}-${ALICE}.json`);
    await tokens.handleCallbackUrl(`http://127.0.0.1:9768/callback?code=old&state=${oldState}`);
    expect(existsSync(path)).toBe(false);

    const second = tokens.generateAuthUrl(APP, 'sec', 'feishu', [], ALICE);
    const newState = new URL(second.authUrl).searchParams.get('state');
    const saved = await tokens.handleCallbackUrl(`http://127.0.0.1:9768/callback?code=new&state=${newState}`);
    expect(saved?.startsWith('✅')).toBe(true);
    expect(readFileSync(path, 'utf8')).toContain(ALICE_SECRET);
  });
});

describe('published identities', () => {
  it('drops the revoked person from proven memory and single-snapshot files', async () => {
    const { identity, revoke } = await loadRevoke();
    const sessionDataDir = join(homeDir, 'sessions');
    mkdirSync(sessionDataDir, { recursive: true });

    identity.writeSessionIdentity(sessionDataDir, 'sess-proven', {
      tool: 'bytedcli', cloudJwt: 'alice-cloud', codeJwt: 'alice-code', openId: ALICE, turnId: 'turn-p',
    }, 'proven');
    identity.writeSessionIdentity(sessionDataDir, 'sess-proven', {
      tool: 'codebase', codeJwt: 'bob-code', openId: BOB, turnId: 'turn-p',
    }, 'proven');
    identity.writeSessionIdentity(sessionDataDir, 'sess-bob', {
      tool: 'bytedcli', cloudJwt: 'bob-cloud', codeJwt: 'bob-code', openId: BOB, turnId: 'turn-b',
    }, 'proven');

    identity.writeSessionIdentity(sessionDataDir, 'sess-single', {
      tool: 'bytedcli', cloudJwt: 'alice-cloud', codeJwt: 'alice-code', openId: ALICE, turnId: 'turn-s',
    }, 'single');
    identity.writeSessionIdentity(sessionDataDir, 'sess-single', {
      tool: 'codebase', codeJwt: 'bob-code', openId: BOB, turnId: 'turn-s',
    }, 'single');
    identity.writeSessionIdentity(sessionDataDir, 'sess-deny', {
      tool: 'lark-cli', mode: 'denied', message: 'need login', turnId: 'turn-d',
    }, 'single');

    const outside = join(homeDir, 'outside.env');
    writeFileSync(outside, `BOTMUX_IDENTITY_OPEN_ID='${ALICE}'\n`);
    const link = join(identity.sessionIdentityDir(sessionDataDir), 'linked.env');
    symlinkSync(outside, link);

    const dropped = identity.dropPublishedIdentitiesForOpenId(sessionDataDir, ALICE);
    expect(dropped).toBeGreaterThan(0);
    expect(identity.recallProvenIdentityContent(sessionDataDir, 'sess-proven', 'turn-p', 'bytedcli')).toBeUndefined();
    expect(identity.recallProvenIdentityContent(sessionDataDir, 'sess-proven', 'turn-p', 'codebase')).toContain(BOB);
    expect(identity.recallProvenIdentityContent(sessionDataDir, 'sess-bob', 'turn-b', 'bytedcli')).toContain(BOB);

    const singleDir = identity.sessionIdentityDataDir(sessionDataDir, 'sess-single');
    expect(existsSync(join(singleDir, 'bytedcli.env'))).toBe(false);
    expect(readFileSync(join(singleDir, 'codebase.env'), 'utf8')).toContain(BOB);
    expect(existsSync(join(identity.sessionIdentityDataDir(sessionDataDir, 'sess-deny'), 'lark-cli.env'))).toBe(true);
    expect(existsSync(link)).toBe(true);
    expect(existsSync(outside)).toBe(true);

    const again = await revoke.revokeTriggerUserAuth({
      openId: ALICE, appId: APP, brand: 'feishu', sessionDataDir,
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(identity.recallProvenIdentityContent(sessionDataDir, 'sess-bob', 'turn-b', 'bytedcli')).toContain(BOB);
  });
});

describe('DELETE /api/bot-trigger-user-auth/users/:openId', () => {
  it('revokes the bound bot\'s user and does not echo secrets', async () => {
    plantStores();
    const prevBots = process.env.BOTS_CONFIG;
    const prevSession = process.env.SESSION_DATA_DIR;
    const configPath = join(homeDir, 'bots.json');
    const sessionDataDir = join(homeDir, 'sessions');
    process.env.BOTS_CONFIG = configPath;
    process.env.SESSION_DATA_DIR = sessionDataDir;
    mkdirSync(sessionDataDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify([{
      larkAppId: APP,
      larkAppSecret: 'secret-must-not-leak',
      cliId: 'codex',
      brand: 'feishu',
    }]));
    let handle: { close: () => Promise<void>; port: number } | null = null;
    try {
      const ipc = await import('../src/core/dashboard-ipc-server.js');
      const registry = await import('../src/bot-registry.js');
      registry.loadBotConfigs().forEach(cfg => registry.registerBot(cfg));
      ipc.setLarkAppId(APP);
      handle = await ipc.startIpcServer({ port: 0, host: '127.0.0.1' });
      const base = `http://127.0.0.1:${handle.port}`;
      const ok = await fetch(`${base}/api/bot-trigger-user-auth/users/${ALICE}`, { method: 'DELETE' });
      const body = await ok.json() as { ok?: boolean; removed?: { userToken?: boolean } };
      expect(ok.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.removed?.userToken).toBe(true);
      const encoded = JSON.stringify(body);
      expect(encoded).not.toContain(ALICE_SECRET);
      expect(encoded).not.toContain('secret-must-not-leak');
      expect(existsSync(join(dataDir(), `user-token-${APP}-${ALICE}.json`))).toBe(false);
      expect(existsSync(join(dataDir(), `user-token-${APP}-${BOB}.json`))).toBe(true);

      const again = await fetch(`${base}/api/bot-trigger-user-auth/users/${ALICE}`, { method: 'DELETE' });
      expect(again.status).toBe(200);
      expect((await again.json() as { ok?: boolean }).ok).toBe(true);

      const bad = await fetch(`${base}/api/bot-trigger-user-auth/users/${encodeURIComponent('bad id')}`, { method: 'DELETE' });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ ok: false, error: 'invalid_open_id' });
    } finally {
      if (handle) await handle.close();
      if (prevBots === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = prevBots;
      if (prevSession === undefined) delete process.env.SESSION_DATA_DIR;
      else process.env.SESSION_DATA_DIR = prevSession;
    }
  });
});
