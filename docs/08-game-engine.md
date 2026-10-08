# Game engine

## Match shape

- 3 rounds, first to 2 round wins (`game.rounds_to_win` / `game.max_rounds`).
- Ties do not award a round, so three tied rounds leave the score 0–0. Per the
  spec, play continues: extra rounds are appended until a champion exists.
- Sudden death is capped at `maxRounds + 6`. Beyond that the match is voided and
  both entries returned — an unbounded tie would otherwise hold two players and
  their stakes in limbo forever.
- **The prize is never paid before a champion exists.** `settleMatch` takes a
  `championSlot` and cannot be called without one.

## Round state machine

```
COUNTDOWN ──(countdownMs)──► ARMED ──(random jitter)──► LIVE ──► RESOLVED
```

| Phase | Button | A click here means |
|---|---|---|
| `COUNTDOWN` | disabled | ignored |
| `ARMED` | live but not valid | **false start — round lost** |
| `LIVE` | valid | reaction measured |
| `RESOLVED` | disabled | rejected as `CLOSED` |

The jitter between ARMED and LIVE is a CSPRNG draw and is never sent to the
client. See `docs/07-anticheat.md` for why that matters more than anything else
in this design.

## Round resolution

`packages/shared/src/rules.ts` — pure, total, deterministic. Precedence:

1. **FORFEIT** — a player left; the one still present takes the round
2. **FALSE_START** — jumping the gun loses outright, even if they would have won
3. **TIMEOUT** — one player never clicked
4. **FASTEST** — lower reaction time wins

Symmetric cases (both forfeit, both jump, neither clicks, identical times) are a
**TIE**, and a tie is replayed rather than awarded.

## Reaction measurement

```
reactionMs = arrivalMono − goAtMono − compensation
```

- `arrivalMono` — stamped the instant the frame is read off the socket, before
  any parsing
- `goAtMono` — when the server sent GO
- `compensation` — `min(minimum-recent-RTT, cap)`

`reactionMs < 0` → clicked before GO → false start.
`reactionMs < game.min_human_reaction_ms` → physically impossible → false start
plus a security flag.

## AI opponent

`modules/game/ai.ts`. The bot's reaction for a round is drawn **before the round
starts** from a Gaussian (Box-Muller over a CSPRNG), clamped to the configured
min/max. It also false-starts and misses at configured rates.

It has no access to the opponent's reaction time and no ability to decide to
win. Its click goes through `applyClick` — the same function a human's click
goes through. Anything else would make it a rigged house player.

**Paid mode:** `ai.paid_policy` defaults to `DISABLED`. A player who finds no
opponent is refunded in full and offered Free or Demo instead.
`HOUSE_STAKE_DISCLOSED` exists for operators who want the fallback, and requires
the opponent to be visibly labelled as house AI. Quietly seating a paying player
against the house is exactly the "unfair or misleading financial situation" the
spec warns about.

## Disconnects

```
socket closes ─► 800ms   (a page refresh reconnects inside this window)
              ─► PLAYER_DISCONNECTED, grace timer starts (15s default)
              ─► returns in time  → PLAYER_RECONNECTED, timer cancelled
              ─► otherwise        → connection = FORFEIT, opponent wins
```

A disconnect only counts when the player's *last* socket closes — a second
device staying connected is not a disconnect.

## Crash recovery

Live matches are held in memory. On boot, **before the server accepts traffic**,
`recoverFromRestart()` cancels every non-terminal match, refunds it, and
releases orphaned fund locks.

Cancelling rather than resuming is deliberate: a half-finished reaction round
cannot be fairly reconstructed, and returning the stake is the outcome neither
player can be wronged by.

Graceful shutdown does the same work in advance — the queue is drained and live
matches are refunded before the process exits.
