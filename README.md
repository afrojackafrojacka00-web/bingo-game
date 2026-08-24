# Bingo – Render Deployment

This project is designed for your existing deployment flow:

```bash
git add .
git commit -m "Upgrade scalable Bingo rooms"
git push origin main
```

Render should build and deploy it using:

- Build Command: `npm install`
- Start Command: `npm start`

## Required Render Environment Variables

Keep your existing values in Render:

- `ADMIN_SECRET`
- `CLOUDINARY_API_KEY`
- `CLOUDINARY_API_SECRET`
- `CLOUDINARY_CLOUD_NAME`
- `DATABASE_URL`
- `TELEGRAM_BOT_TOKEN`

Do **not** put real secret values into GitHub. The server reads them with `process.env`.

## Optional variables

- `DRAW_INTERVAL_MS=2500`
- `MAX_CARDS_PER_PLAYER=500`

Render automatically provides `PORT`, so you do not need to create it manually.

## Game architecture

There are six independent stake rooms: `10, 20, 50, 100, 200, 500`.
Each room has independent players, countdown, selected cards, ready players, prize pool, game session and number draw stream.

A player can select multiple cards in a room. Card numbers are not globally exclusive, so thousands of players can select the same card number without contention.

The server is authoritative for balances, entry deductions, refunds, number draws and Bingo validation.

## Important production note

This version is designed to be efficient on a single Node.js/Socket.IO process. If you later run multiple Render instances, room state must be moved from process memory to a shared system such as Redis, and Socket.IO must use a compatible adapter/sticky-session setup. Do not horizontally scale the current in-memory room state without that change.
