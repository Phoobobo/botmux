# Request-bound group send

Integrators that must prove "this request produced that visible message" cannot
use `/api/trigger` (no message id, no read-back) or hall announcements (may
skip). These two daemon IPC routes give an at-most-once, provable post from the
daemon's own bot.

## `POST /api/groups/:chatId/messages`

Body is exactly `{ "requestId": "<[A-Za-z0-9_-]{8,64}>", "content": "<plain text ≤ 8192 bytes>" }`.

| Response | Meaning |
|---|---|
| `200 {ok, messageId, requestId, chatId, replayed}` | Sent (or the original send for this `requestId` replayed). |
| `400 invalid_request` | Body shape. |
| `409 request_conflict` | Same `requestId`, different content. Nothing sent. |
| `409 outcome_unknown` | A previous attempt may have sent but cannot be reconciled any more. Never re-sent; use a new `requestId` only if a duplicate is acceptable. |
| `502 send_failed` (`retryable:true`) | Provider error. Retrying the same `requestId` within 50 minutes reuses the Lark `uuid`, so Lark returns the original message instead of a second one. |
| `503 store_unavailable` | Dedupe store unreadable/unwritable. Fail closed; nothing sent. |

Dedupe: a durable per-bot record (`<dataDir>/group-sends-<appId>.json`, 0600,
fsync) is written **before** the provider call; the Lark IM `uuid` is derived
from `(appId, chatId, requestId)` and only reused inside 50 minutes (Lark's
dedupe window is ~1 hour).

## `GET /api/groups/:chatId/messages/:messageId`

Independent read-back via the IM message API: `{ok, messageId, chatId, deleted,
msgType, sender:{id,idType,senderType,isSelf}, createTime, text, requestId}`.
`requestId` is non-null only when the durable record binds it to this message.
`404 not_found`, `409 chat_mismatch`, `502 read_failed`.

Both routes require a bound bot (same as other `/api/groups/:chatId/*` routes).
