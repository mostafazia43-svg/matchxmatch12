# Development roadmap

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Architecture, schema, API, WS, security design | ✅ done |
| 1 | Monorepo, env, Docker, migrations | ✅ done |
| 2 | Shared money + rules + progression (+ tests) | ✅ done |
| 3 | Telegram auth, sessions, guards (+ tests) | ✅ done |
| 4 | Ledger, wallet, TON provider abstraction | ✅ done |
| 5 | Matchmaking, game engine, AI, WebSocket | ✅ done |
| 6 | Progression, leaderboard, history | ✅ done |
| 7 | Admin API + panel | ✅ done |
| 8 | Telegram bot | ✅ done |
| 9 | Mini App (all screens) | ✅ done |
| 10 | Ledger integration tests | ⚠️ written, needs a database to run |

## Phase 10 — run the integration suite

`packages/backend/src/__tests__/ledger.integration.test.ts` covers the
guarantees that live in Postgres rather than in TypeScript: idempotency under
concurrency, the non-negative-balance CHECK, exact prize payout, refunds, and
book-balancing. It **skips** when no database is reachable.

```bash
docker compose up -d postgres
DATABASE_URL=postgres://clickbattle:clickbattle@localhost:5432/clickbattle npm test
```

Do this before any real deployment. These are the tests that prove money cannot
be created or destroyed.

## Next: before real money

1. **Run phase 10.** Non-negotiable.
2. **End-to-end match test** — two WebSocket clients through a full 3-round
   match, including the false-start and disconnect paths.
3. **Real TON integration** — set `TON_PROVIDER=tonapi`, deposit a small amount,
   confirm the memo attribution works, withdraw it back manually.
4. **Load test the socket path** — the engine is single-instance; find the real
   ceiling for concurrent live matches before users do.
5. **Legal review** — licensing, KYC/AML, geo-restriction of paid mode,
   responsible-play limits. The software does not decide whether you may operate
   it.

## Later

**Fairness and integrity**
- Collusion detection (paired accounts repeatedly matching each other)
- Device fingerprinting for multi-account detection
- Per-player deposit/loss limits and self-exclusion

**Scale**
- Match ownership in Redis + sticky socket routing → multi-instance backend
- Read replica for leaderboard and history
- Partition `game_events` by month

**Product**
- Tournaments and brackets
- Friend challenges via a Telegram deep link (`start_param` is already parsed)
- Seasons with a resetting leaderboard
- Daily streak rewards
- Spectating a live match
- Automated payouts behind a dedicated signer service (never in the app process)

**Operations**
- Prometheus metrics + Grafana
- Sentry for the Mini App
- Automated backup verification
