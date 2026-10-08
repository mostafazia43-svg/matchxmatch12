# Admin

## Access

Membership of `ADMIN_TELEGRAM_IDS`, checked against the environment on **every**
request rather than carried in the token. Revoking an admin takes effect on
their next request.

The panel lives inside the Mini App because the operator is already a
Telegram-verified user; a separate admin app would need a second auth system,
which is a second thing to get wrong. Hiding the tab from non-admins is
convenience — the server enforces access regardless.

## Audit

Every state-changing admin route writes an `admin_actions` row **before**
returning: who, what, which target, the payload, and the IP. There is no
privileged action without a trail — including the ones that move money.

## Surfaces

**Overview** — revenue (total commission), deposits, withdrawals, prizes paid,
user balances held, funds locked in live matches; players total / online /
active-24h / blocked; matches live / queued / today and the free-paid-demo
split; alert counts; which TON provider is active and whether it is live.

**Users** — search by username or Telegram ID; block/unblock (which also revokes
sessions, drops the player from the queue and closes their sockets); balance
adjustment.

**Withdrawals** — the review queue. Approve → Mark sent (with the on-chain
hash), or Reject (which refunds in full). The panel states plainly that the
money has already left the player's balance, so the reviewer knows a rejection
is a refund and not a cancellation.

**Security** — open `suspicious_events`. Only physically impossible reactions
are flagged; ordinary false starts are handled by the game rules and are
deliberately not escalated, so the queue stays meaningful.

**Settings** — every runtime setting, grouped, validated against the same Zod
schema the server reads. Changes apply within ~5 seconds with no restart.

## Balance adjustment

Goes through `ledger.record()` as an `ADMIN_ADJUSTMENT` row with an idempotency
key and a **mandatory reason** — never a direct UPDATE on the balance. That is
what keeps the ledger a complete explanation of every wallet: if the numbers
move, there is a row saying why and who did it.

## Configurable at runtime

Modes on/off · paid tiers · commission bps · rounds to win · max rounds ·
countdown length · round timeout · GO jitter window · minimum human reaction ·
RTT compensation cap · disconnect grace · matchmaking timeout · AI enable,
reaction distribution and paid policy · every XP and points reward · the level
curve · the Telegram membership gate and which modes it applies to · deposit and
withdrawal enable, minimums, fee and required confirmations · maintenance mode
and its message.
