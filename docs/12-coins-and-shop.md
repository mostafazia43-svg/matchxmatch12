# 12 - Coins, titles, game styles and the shop

## Coins
- A spendable balance (`player_progress.coins`), separate from ranking points.
- A win pays the points it earned (10 for a free win, plus the streak bonus)
  multiplied by the game style (Classic/Sprint x1, Marathon x2, Endurance x3),
  plus 50 coins for every level gained.
- Matches against the AI and demo matches pay no coins, so the bot cannot be farmed.
- Logic: `packages/shared/src/styles.ts` (`computeCoins`), applied in
  `modules/game/settlement.ts`, inside the same transaction as XP and points.

## Game styles (free and demo only; paid matches are always Classic)
| Style     | Level | Rounds            |
|-----------|-------|-------------------|
| Classic   | 1     | admin setting (3 of 5) |
| Sprint    | 2     | first to 2 of 3   |
| Marathon  | 4     | first to 4 of 7   |
| Endurance | 8     | first to 5 of 9   |
Players only match inside the same style (the style is part of the queue key).

## Titles
Level titles are free (Rookie ... Legend). Titles bought in the shop replace
the level title where a name is shown.

## Shop
- Catalogue: `packages/shared/src/shop.ts` (titles and GO-button colours).
- Server: `modules/shop/service.ts`, routes `GET /api/shop`, `POST /api/shop/buy`,
  `POST /api/shop/equip`.
- A purchase locks the player's progress row, checks level, ownership and
  balance, then deducts the catalogue price and inserts the purchase. The
  `coins >= 0` CHECK and `UNIQUE(user_id, item_id)` back that up.
- Everything sold is cosmetic. Nothing changes timing or who wins a round.
- Migrations: `0003` (3-of-5 default), `0004` (coins), `0005` (shop).
