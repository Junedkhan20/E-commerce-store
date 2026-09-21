# Uniblox — Reliable Checkout & Rewards Service

A concise Node.js/Express backend demonstrating reliable checkout, inventory guards, idempotency, milestone coupons, integer-cents money handling, and concurrency controls. Includes a small demo frontend.

## Quick start

```bash
cd backend
npm install
npm start        # server on http://localhost:3000
npm run dev      # with --watch
npm test         # full suite (jest + supertest)
```

Frontend is served statically:
- Open `http://localhost:3000/` — demo UI for products, cart, checkout, admin, and event log.

## Key endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Health check |
| GET | `/products` | List products |
| POST | `/carts` | Create cart |
| GET | `/carts/:cartId` | View cart (with totals) |
| POST | `/carts/:cartId/items` | Add item (qty) |
| PUT | `/carts/:cartId/items/:productId` | Update qty |
| DELETE | `/carts/:cartId/items/:productId` | Remove item |
| POST | `/carts/:cartId/checkout` | Checkout (body: `{idempotencyKey?, couponCode?}`) |
| GET | `/orders/:orderId` | View order |
| POST | `/admin/coupons/generate` | Generate milestone coupon |
| GET | `/admin/report` | Admin summary (reconciles orders + coupons) |

## Design highlights

- **Integer cents** for all money; no floating-point errors.
- **Idempotency keys** prevent duplicate orders on retry.
- **Per-cart checkout locks** (`Set`) prevent concurrent double-checkout.
- **Inventory reserved at add-to-cart**, returned on removal; never oversells.
- **Milestone coupons** (`n` orders → `x%` off); admin-triggered; single redemption.
- **In-memory store** with mutex/idempotency; production evolution mapped in `DECISIONS.md`.

## Tests

```bash
npm test
```

Covers: cart lifecycle, inventory limits, basic checkout, coupon redemption/rejection, idempotency retries, concurrent checkout, report reconciliation, milestone coupon generation, discount/money precision.

## Files

- `backend/src/index.js` — Express routes + error handler
- `backend/src/service.js` — Business logic + invariants
- `backend/src/store.js` — In-memory store + locks
- `backend/src/money.js` — Integer-cents utilities
- `backend/src/errors.js` — Stable error codes
- `backend/DECISIONS.md` — Design decisions, ambiguities, production evolution
- `frontend/index.html` — Small demo UI
