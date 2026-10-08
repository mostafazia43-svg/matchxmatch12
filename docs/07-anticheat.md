# Anti-cheat & timing

This is the most consequential design document in the project. A reaction game
played for real money is only fair if the timing cannot be gamed, and most
naive designs can be.

## 1. The threat

The client is fully controlled by the player. They can modify the JavaScript,
run a script that clicks for them, patch timestamps, delay packets, or run the
Mini App inside an instrumented browser. So the honest question is not "how do
we stop them modifying the client" — we cannot — but **"what can a modified
client actually gain?"**

## 2. Rejected designs, and why

### ❌ Client reports its own reaction time

`{ reactionMs: 142 }` — the obvious approach, and completely broken. A modified
client reports `95` every round and wins everything. No server-side validation
helps, because a plausible-looking number is indistinguishable from a real one.

### ❌ Server announces the GO timestamp in advance

`ROUND_START { goAt: <server time> }` with the client scheduling its own render
is the design most multiplayer tutorials suggest. It is also exploitable: a
modified client schedules its click *at* `goAt` instead of reacting to it,
producing a ~0ms reaction. Clock synchronisation does not fix this — it is what
makes it possible.

### ❌ Full RTT compensation from client-reported latency

Letting the client tell us its ping means letting it claim a large one; every
millisecond claimed is a millisecond subtracted from its measured reaction.

## 3. The design in use

### 3.1 GO is never announced

The visible countdown (3-2-1) ends, and then the round enters an **ARMED**
phase of unpredictable length — a CSPRNG draw from
`game.go_jitter_min_ms`…`game.go_jitter_max_ms` (300–2000ms by default).
`ROUND_START` is sent **at** the GO instant, not before it.

There is therefore no future timestamp to pre-fire against. A script that
clicks "as soon as possible" clicks during ARMED, which is a false start and
loses the round. This is the single most important property of the design: it
converts the strongest attack into a self-inflicted loss.

The jitter is drawn with `node:crypto.randomInt`, not `Math.random`, so it is
not predictable from previous rounds.

### 3.2 A click carries no data

```ts
{ t: 'CLICK', matchId, roundNo, seq }
```

No timestamp, no reaction time, no client clock reading. The server stamps
arrival with its own monotonic clock, and does so as the *first statement*
after the frame is read off the socket — before JSON parsing, before any
lookup, so process scheduling is never charged to the player.

`registerClick` (in `realtime/gateway.ts`) is the only code path between the
socket and the engine, and it awaits nothing.

### 3.3 Latency compensation, bounded

A player on a slow connection genuinely deserves compensation: the GO frame
took time to reach them and their click took time to come back. The server
subtracts a full RTT:

```
reactionMs = arrivalMono − goAtMono − compensation
compensation = min(rttFor(user), game.max_rtt_compensation_ms, 400ms)
```

Two deliberate choices make this hard to abuse:

- **RTT is server-measured**, from ping/pong the server initiates. The client
  never states its latency.
- **`rttFor` returns the MINIMUM of recent samples**, not the mean. A client
  can only make its RTT look *worse* (by delaying pongs). Inflating a mean is
  easy; inflating a minimum requires delaying *every* sample consistently, and
  one honest round trip pulls it straight back down.

**Residual exposure, stated plainly:** a client that consistently delays every
pong can still gain up to the compensation cap (250ms by default). This is
bounded, logged, and tunable. Operators running high-stakes tiers should lower
`game.max_rtt_compensation_ms` — the trade-off is that genuinely high-latency
players are then under-compensated. There is no design that compensates real
latency without also compensating faked latency; the cap is the control.

### 3.4 Physically impossible reactions

Human visual reaction has a floor around 100ms. A measured reaction below
`game.min_human_reaction_ms` (90ms, with an absolute floor of 80ms in
`TIMING.ABSOLUTE_MIN_REACTION_MS`) is not a fast human — it is an auto-clicker
or a replayed packet.

Such a click is treated as a **false start** (the player loses the round) and
raises a `suspicious_events` row at severity 3 for admin review.

Note the deliberate asymmetry: an ordinary early click during ARMED is a normal
human mistake, punished by the rules and **not** escalated to the admin queue.
Only the physically impossible is flagged. Flooding the security queue with
honest mistakes would make it useless.

## 4. What else the server owns

| Decision | Where it is made | Client's role |
|---|---|---|
| Who you are | `modules/auth/telegram.ts` (HMAC over initData) | supplies the signed blob |
| Your balance | `wallets` table + DB CHECK | displays it |
| Entry fee | `app_settings` + `isTierAllowed` | picks from an offered list |
| Commission | `computeMatchEconomics` (server) | renders the same number |
| Prize | `computeMatchEconomics` (server) | renders it |
| Round winner | `rules.resolveRound` (server) | renders it |
| Match champion | `rules.matchProgress` (server) | renders it |
| XP / points / level | `settlement.applyProgression` | renders it |

The shared `rules.ts` and `money.ts` are imported by the client, but only so it
can *preview* the same numbers. Nothing the client computes is ever sent back
and trusted.

## 5. Other handled attacks

| Attack | Defence |
|---|---|
| Forged identity | initData HMAC verified with `BOT_TOKEN`, timing-safe compare |
| Replayed initData | `auth_date` age check (`AUTH_INITDATA_MAX_AGE_SECONDS`) |
| Stolen session after a ban | `sessions.revoked_at` checked on every request and WS frame |
| Double-clicking a round | `round.clicked[slot]` guard; duplicates rejected, not counted |
| Clicking a finished round | phase check — `RESOLVED` rejects with `CLOSED` |
| Clicking another player's match | `registerClick` resolves the slot from the authenticated user |
| Message flooding | per-socket token bucket (40 burst / 20 per second) |
| API scraping | Redis-backed rate limiter, per-route budgets |
| Staking the same balance twice | funds LOCKED on queue join; DB CHECK forbids negative |
| Double prize payout | `idempotency_key` UNIQUE on `wallet_transactions` |
| Double deposit credit | `deposits.chain_tx_hash` UNIQUE **and** a ledger idempotency key |
| Rage-quitting a losing match | disconnect grace, then forfeit — opponent takes the match |
| Many sockets to amplify | `WS_MAX_CONNECTIONS_PER_USER`, oldest evicted |
| Blocked user still playing | sessions revoked and sockets closed at block time |

## 6. What is logged

`game_events` records every round transition, every early click, and every
impossible reaction — enough to reconstruct any disputed match. Financial
records live separately in the append-only ledger, so a gameplay dispute and a
money dispute are answered from different tables that must agree.

## 7. Honest limitations

1. **RTT inflation** within the compensation cap, as described in 3.3.
2. **Two accounts, one person** — collusion in paid mode is not detected. A
   real deployment wants device fingerprinting and paired-account analysis;
   `suspicious_events` is the hook for it.
3. **A genuinely faster human wins.** That is the game working, not a cheat.
4. **The engine is single-instance.** Live matches live in one process's
   memory. Scaling out needs sticky routing per match id (Redis-based
   ownership); until then, run one backend instance and scale vertically.
