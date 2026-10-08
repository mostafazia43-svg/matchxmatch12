# Authentication

## Model

There is no registration, no password, no email. A player exists because
Telegram vouched for them.

```
Telegram client
   │  initData (signed by Telegram using the bot token)
   ▼
POST /api/auth/telegram
   │  verifyInitData()  ── HMAC-SHA256, timing-safe compare, age-checked
   ▼
provisionUser()  ── users + telegram_accounts + wallets + player_progress
   │                (one transaction — no half-created accounts)
   ▼
issueToken()  ── HS256 JWT { sub, tg, jti } + a `sessions` row
```

## initData verification

Implemented in `packages/backend/src/modules/auth/telegram.ts`. This is the
trust boundary of the entire product.

1. Parse the query string; extract `hash`.
2. Build the data-check-string: every other field as `key=value`, sorted, joined
   with `\n`. (`signature` stays in — Telegram hashes it too.)
3. `secret = HMAC_SHA256(key="WebAppData", msg=BOT_TOKEN)` — note the inversion
   that trips people up: the literal string is the *key*, the bot token is the
   *message*.
4. `expected = HMAC_SHA256(key=secret, msg=dataCheckString)`.
5. Compare with `timingSafeEqual`. A byte-by-byte early return would leak the
   expected hash to a patient attacker.
6. Reject if `auth_date` is older than `AUTH_INITDATA_MAX_AGE_SECONDS`, or more
   than 5 minutes in the future.
7. Read the user **only** from the verified payload — never from a separate
   request body field.

Failure reasons: `MALFORMED`, `MISSING_HASH`, `BAD_SIGNATURE`, `EXPIRED`,
`MISSING_USER`, `NO_BOT_TOKEN`.

The test suite covers each of these, including the classic attack: take your own
valid initData and swap in someone else's user id.

## Sessions

The JWT carries a `jti` that is also a row in `sessions`. Every authenticated
request re-checks that row, so a token can be revoked server-side:

- blocking a user revokes all their sessions and closes their sockets
- logout revokes one session
- expiry is enforced in both the token and the row

**The token grants no permissions.** Admin status is re-derived from
`ADMIN_TELEGRAM_IDS` on every request, so promoting or demoting an admin takes
effect immediately rather than whenever their session happens to expire.

## Development authentication

`POST /api/auth/dev` exists so the Mini App can be developed in a plain browser.
It is guarded three ways: `ALLOW_DEV_AUTH` must be true, `NODE_ENV` must not be
production, and `assertProductionSafety()` refuses to boot a production process
with the flag on. Without that last guard it would be a total auth bypass.

## WebSocket

The socket authenticates with the same JWT in a `HELLO` frame, resolves the same
session row, and re-checks the block flag. An unauthenticated socket may send
nothing else and is dropped after 10 seconds.
