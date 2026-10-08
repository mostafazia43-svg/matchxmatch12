# Wallet, ledger & payments

## Money representation

`bigint` micro-USDT everywhere in application code; `BIGINT` in Postgres.
**No float ever touches a balance.** Full rationale at the top of
`packages/shared/src/money.ts`.

On the wire: a decimal string (`"9500000"`). JSON has no bigint.

## Commission

Deducted from **each player's entry separately**, not once from the pot:

| Entry | Fee each | Total fee | Champion receives |
|---|---|---|---|
| $5 | $0.25 | $0.50 | **$9.50** |
| $10 | $0.50 | $1.00 | **$19.00** |
| $30 | $1.50 | $3.00 | **$57.00** |
| $50 | $2.50 | $5.00 | **$95.00** |

One function computes this — `computeMatchEconomics` — imported by the server
(authoritative), the client (preview) and the tests. They cannot drift apart.

Rounding is **down**, so the house never collects a fraction it did not earn;
the remainder flows into the prize. `gross === prize + commission` is asserted
in the test suite across a range of amounts, not just the four tiers.

## Balances

```
wallets.available_micros   spendable    CHECK (>= 0)
wallets.locked_micros      reserved     CHECK (>= 0)
```

Locked money is still the player's — it is reserved so it cannot be staked in
two matches at once or withdrawn mid-match. Non-negativity is a **database
constraint**, not an application `if`: a bug that computes a bad debit fails the
transaction rather than creating USDT.

## The ledger

`wallet_transactions` is append-only. Every row carries a deterministic
`idempotency_key` with a UNIQUE index.

The write order in `ledger.record()` is deliberate:

1. INSERT the ledger row `ON CONFLICT (idempotency_key) DO NOTHING`
2. if nothing was inserted → already processed → **return without touching the balance**
3. UPDATE the balance
4. stamp `balance_after_micros` on the row just inserted

Reversing 1 and 3 would let a retry double-apply the balance before failing on
the insert. This ordering is what makes "the prize is paid exactly once" true
even under concurrent retries — there is a test for the concurrent case
specifically.

### Transaction types

| Type | Sign | Moves balance | Meaning |
|---|---|---|---|
| `DEPOSIT` | + | yes | credited from a confirmed on-chain transfer |
| `MATCH_ENTRY` | − | yes | entry consumed from locked funds |
| `COMMISSION` | − | **no** | explains the fee inside the entry |
| `PRIZE` | + | yes | paid to the champion |
| `REFUND` | + | yes | cancelled match, or rejected withdrawal |
| `WITHDRAWAL` | − | yes | debited at request time |
| `ADMIN_ADJUSTMENT` | ± | yes | manual, reason required, audited |

`COMMISSION` has `affects_balance = false`. It is bookkeeping: the fee was
already inside the `MATCH_ENTRY` debit, and charging for both would bill the
player twice. It exists so a player can see exactly where their $5 went, and so
platform revenue is a simple `SUM` over one type.

## Match money lifecycle

```
queue join (PAID)   available −entry, locked +entry    (no ledger row: nothing spent yet)
match starts        locked −entry, MATCH_ENTRY −entry  + COMMISSION (bookkeeping)
champion decided    PRIZE +prize to the winner
cancelled before    release the lock
cancelled after     REFUND +entry to both players
```

Every one of these is keyed on the match id, so re-running settlement — a retry,
a duplicate event, the crash-recovery sweep — is a no-op rather than a second
payout.

## Deposits

Attribution is by **memo**: `CB-` + the first 10 hex characters of the user id.
The watcher polls the provider and calls `creditDeposit`, which is idempotent
twice over: `deposits.chain_tx_hash` is UNIQUE *and* the ledger key is derived
from the same hash. Either guard alone would do; both are there because
crediting money twice is unrecoverable.

A transfer with no matching memo is stored as `ORPHANED` for manual review —
never guessed at. An ambiguous memo (a prefix collision) also goes to review
rather than being credited to one of the candidates.

## Withdrawals

The debit happens **at request time**, not at payout time — otherwise a player
could stake the same balance in a match while a withdrawal for it was queued.

```
request    →  WITHDRAWAL −amount (CONFIRMED), withdrawals.status = PENDING
approve    →  status = APPROVED
mark sent  →  status = SENT, chain_tx_hash recorded
reject     →  REFUND +amount, status = REJECTED
```

`requestKey` (client-generated) makes the request idempotent.

## TON provider

`modules/payments/provider.ts` defines the interface; drivers are selected with
`TON_PROVIDER`.

- **`mock`** — development only. Deposits are injected by the admin tool or the
  tests; it never claims an on-chain confirmation, and `tonProvider()` throws if
  it is selected in production.
- **`tonapi`** — reads jetton transfers into the platform address and filters
  them to `USDT_JETTON_MASTER`, so a worthless look-alike jetton cannot credit a
  real balance. Amounts are normalised to 6 decimals regardless of the jetton's
  own precision.

**Automated payouts are off by default.** Signing needs a hot wallet key; until
an operator explicitly enables it, withdrawals are approved in the admin panel
and paid out by hand. That is the safer default for real money, and it is why
`sendPayout` throws a clear error rather than pretending to send.

No private key, seed phrase or mnemonic appears anywhere in this repository.
