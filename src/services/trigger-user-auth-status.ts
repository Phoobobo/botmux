/**
 * Per-person trigger-user credential status.
 *
 * A device sharing one machine needs to ask "is this open_id authorized, and
 * until when?" without opening token files itself. This reports that for the
 * three stores the turn path actually consults:
 *
 *   - `bytedcli` — isolated HOME, asked via `bytedcli auth status`
 *   - `lark-cli` — isolated HOME with a per-person device-login file
 *   - `user-token` — legacy bot-app OAuth file (`user-token-<app>-<openId>.json`)
 *
 * States are `authorized`, `needs-login`, or `unknown` (the probe could not
 * tell; an existing login is not cleared). Expiry is included only when the
 * store records one. Token, JWT, and refresh-token contents are never copied
 * onto the result.
 */
import type { Brand } from '../im/lark/lark-hosts.js';
import { describeBytedcliAuth } from './bytedcli-auth.js';
import { describeLarkCliAuth } from './lark-cli-auth.js';
import { userTokenAuthState } from '../utils/user-token.js';

export type TriggerUserToolAuthState = 'authorized' | 'needs-login' | 'unknown';

export interface TriggerUserToolStatus {
  state: TriggerUserToolAuthState;
  /** Present only when this store records an expiry. */
  expiresAt?: string;
  /** Legacy user-token refresh expiry. Absent for the CLI homes. */
  refreshExpiresAt?: string;
}

export interface TriggerUserAuthUserStatus {
  openId: string;
  tools: {
    bytedcli: TriggerUserToolStatus;
    'lark-cli': TriggerUserToolStatus;
    'user-token': TriggerUserToolStatus;
  };
}

const STATES = new Set<TriggerUserToolAuthState>(['authorized', 'needs-login', 'unknown']);

function toolStatus(raw: {
  state: string;
  expiresAt?: string;
  refreshExpiresAt?: string;
}): TriggerUserToolStatus {
  const state = STATES.has(raw.state as TriggerUserToolAuthState)
    ? raw.state as TriggerUserToolAuthState
    : 'unknown';
  const out: TriggerUserToolStatus = { state };
  if (typeof raw.expiresAt === 'string' && raw.expiresAt) out.expiresAt = raw.expiresAt;
  if (typeof raw.refreshExpiresAt === 'string' && raw.refreshExpiresAt) out.refreshExpiresAt = raw.refreshExpiresAt;
  return out;
}

/**
 * Status for one open_id. Does not start a login, create a HOME, or read
 * token contents into the returned object.
 */
export async function queryTriggerUserAuthStatus(input: {
  appId: string;
  brand: Brand;
  openId: string;
}): Promise<TriggerUserAuthUserStatus> {
  const [bytedcli, larkCli, userToken] = await Promise.all([
    describeBytedcliAuth(input.openId),
    Promise.resolve(describeLarkCliAuth(input.openId)),
    Promise.resolve(userTokenAuthState(input.appId, input.brand, input.openId)),
  ]);
  return {
    openId: input.openId,
    tools: {
      bytedcli: toolStatus(bytedcli),
      'lark-cli': toolStatus(larkCli),
      'user-token': toolStatus(userToken),
    },
  };
}
