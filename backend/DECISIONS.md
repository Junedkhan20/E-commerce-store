# Design Decisions

## System Invariants

1. **Inventory never negative** — Checked at add-to-cart, update, and checkout. Inventory is deducted when items enter the cart to prevent oversell across concurrent adds.
2. **Cart checked out at most once** — Enforced by cart status (`open` → `checked_out`) and a per-cart checkout lock.
3. **Order created at most once per idempotency key** — Stored in `idempotency` map; retries with same key return the existing order.
4. **Coupon redeemed at most once** — Coupon has `redeemed` flag; set atomically after order creation.
5. **Coupon generated only for unrewarded milestones** — `lastGeneratedMilestone` tracks the highest milestone rewarded.
6. **Money never negative** — `totalAfterDiscount` clamps to zero; discounts use integer floor.
7. **Report reconciles with orders** — Report is computed from order and coupon arrays; repeated reads are idempotent.

## Ambiguities & Selected Semantics

| Ambiguity | Decision |
|-----------|----------|
| Price at checkout: capture price at add-to-cart or use current? | **Use current price at checkout.** Products may change price; the order records the unit price at checkout so the customer sees what they pay now. This is documented to the client. |
| Inventory reservation: reserve at add-to-cart or only at checkout? | **Reserve at add-to-cart.** Simpler and safer for demo; prevents oversell without complex reservation TTLs. Inventory is returned on cart item removal. |
| Coupon generation: automatic on nth order or admin-triggered? | **Admin-triggered.** The requirement says "administrator can request coupon generation." Admin must call the endpoint; if milestone is reached and unrewarded, a coupon is created. |
| Coupon scope: single product or whole cart? | **Whole cart (percentage off subtotal).** Simpler and matches typical ecommerce. |
| Coupon milestone: per-customer or global? | **Global.** "Every nth successfully placed order" → global counter across all customers. |
| Coupon expiration: time-limited or unlimited? | **Unlimited.** Not specified; coupons persist until redeemed. |
| Idempotency key scope: per-cart or global? | **Global.** Any checkout with same key returns the same order. |
| Cart status after failed checkout: stays open or locked? | **Stays open.** If checkout fails (validation, coupon error), cart remains open for retry. |

## Material Design Decisions

### Decision: Integer cents for all money

**Context:** Floating-point rounding causes subtle bugs (e.g., `0.1 + 0.2 = 0.30000000000000004`). Prices, totals, discounts must be exact.

**Options considered:**
- JavaScript `number` with `toFixed(2)` everywhere
- Dedicated decimal library (decimal.js, big.js)
- Integer cents (this choice)

**Choice:** Integer cents throughout storage and computation. API accepts dollars (e.g., `49.99`), normalizes to cents on input, returns dollars on output.

**Why:** Zero dependencies, zero rounding errors, fast, simple. Floor-based discount ensures determinism.

**Consequences:** API consumers must send prices with at most 2 decimal places. Large values require `Number.isSafeInteger` guard (added).

---

### Decision: In-memory store with per-cart mutex

**Context:** Need to demonstrate concurrency invariants without external DB dependency.

**Options considered:**
- SQLite with `better-sqlite3` (synchronous, good for tests)
- In-memory with no locks (unsafe)
- In-memory with async locks per cart (this choice)

**Choice:** `Store` class with `checkoutLocks` Set (per-cart) and `idempotency` Map. All operations synchronous.

**Why:** Shows intent clearly; the lock set and idempotency map map directly to Redis SETNX + Lua scripts or DB advisory locks in production.

**Consequences:** Single-process only. Horizontal scaling requires distributed lock service and DB transactions.

---

### Decision: Idempotency key optional, returned order on retry

**Context:** Clients may retry checkout after timeout. Must not double-charge.

**Options considered:**
- Require idempotency key on all checkouts
- Optional key; if provided, return existing order
- Generate key server-side and return to client

**Choice:** Optional client-provided key. If provided and matches existing order, return that order. If not provided, rely on cart status + lock to prevent double-checkout.

**Why:** Low friction for simple clients; strong guarantee for those who need it.

**Consequences:** Client must generate stable key (e.g., UUID) per checkout attempt.

---

### Decision: Coupon generated on admin request, not automatically

**Context:** "An administrator can request coupon generation."

**Options considered:**
- Auto-generate on nth order completion
- Admin POST to `/admin/coupons/generate` (this choice)

**Choice:** Admin endpoint. If milestone reached and not already rewarded, create coupon.

**Why:** Explicit admin control; matches requirement wording; allows business to review before issuing.

**Consequences:** Admin must poll or be notified. Could add webhook in production.

---

### Decision: Discount uses integer floor (truncation)

**Context:** 10% of $24.99 = $2.499. How to round?

**Options considered:**
- Round to nearest cent (banker's rounding)
- Floor (truncate fractional cents) — this choice
- Ceil (round up, benefits customer)

**Choice:** Floor. `Math.floor(subtotalCents * percent / 100)`.

**Why:** Deterministic, never over-discounts, never makes total negative. Matches typical retailer practice.

**Consequences:** Customer loses fractional cent (e.g., $2.499 → $2.49 discount). Documented.

---

### Decision: Error model with stable codes

**Context:** "Return errors that are distinguishable and useful to an API client."

**Choice:** Custom error classes (`ValidationError`, `ConflictError`, `NotFoundError`, `CouponError`) each with `code` and `httpStatus`. Error handler maps to JSON: `{ error: { code, message, details? } }`.

**Why:** Clients can switch on `code` without parsing messages. Extensible.

**Consequences:** Must keep codes stable across versions.

---

## Transaction, Concurrency, Idempotency Strategy

| Concern | Mechanism |
|---------|-----------|
| Concurrent checkout on same cart | `checkoutLocks` Set (mutex); second attempt gets 409 |
| Concurrent checkout on different carts for same limited product | Inventory deducted at add-to-cart; exhausted inventory blocks further adds |
| Retry after timeout | Client sends `idempotencyKey`; service returns existing order if key seen |
| Coupon double-redeem | `coupon.redeemed` boolean; set after order creation, only on success |
| Coupon generation race | Single-process; `lastGeneratedMilestone` guard. In prod: DB unique constraint on milestone |

**Production evolution:**
- Replace `checkoutLocks` with Redis `SET key NX EX 30` or DB `SELECT FOR UPDATE`.
- Replace `idempotency` Map with DB table `idempotency_keys(key PK, order_id, created_at)`.
- Replace inventory deduction with `UPDATE products SET inventory = inventory - ? WHERE id = ? AND inventory >= ?` (atomic, returns rows affected).
- Move coupon generation to DB transaction with `WHERE NOT EXISTS (SELECT 1 FROM coupons WHERE milestone = ?)`.

---

## Money & Rounding Rules

- All prices stored as integer cents (`priceCents`).
- Input: `toCents(49.99) → 4999`. Rounds to nearest cent.
- Discount: `floor(subtotalCents * percent / 100)`.
- Total: `max(0, subtotalCents - discountCents)`.
- Output: `toDollars(4999) → 49.99`.
- No floating-point math anywhere in business logic.

---

## Error Model Choices

| HTTP Status | Code | When |
|-------------|------|------|
| 400 | `VALIDATION_ERROR` | Bad input (qty not int, missing fields) |
| 404 | `NOT_FOUND` | Cart, product, order, item not found |
| 409 | `CONFLICT` | Cart already checked out, checkout in progress |
| 422 | `COUPON_ERROR` | Invalid/already-redeemed coupon |
| 500 | `INTERNAL_ERROR` | Unexpected bug |

All errors return: `{ error: { code, message, details? } }`.

---

## Implemented vs Deferred

### Implemented
- Product CRUD (seeded, read-only via API)
- Cart CRUD with inventory deduction
- Checkout with idempotency key support
- Coupon admin generation (milestone-based)
- Coupon redemption (once)
- Admin report with reconciliation
- Full test suite covering concurrency, idempotency, coupons, money

### Deferred (would add with more time)
- **Authentication/Authorization** — JWT or API keys; admin vs customer roles
- **Persistence** — PostgreSQL with Prisma/SQL; migrations
- **Horizontal scaling** — Redis for locks/idempotency; stateless workers
- **Coupon expiration** — TTL, usage limits, product restrictions
- **Partial refunds / cancellations** — Order status machine, inventory return
- **Price history** — Store product price at time of order (already done in order items)
- **Webhooks** — Order created, coupon generated events
- **Rate limiting** — Per-IP / per-customer
- **Audit log** — All admin actions, checkout attempts
- **Observability** — Structured logging, metrics, tracing

---

## Production Evolution (Multiple Instances)

| Component | Single Instance | Multi-Instance Production |
|-----------|-----------------|---------------------------|
| Store | In-memory arrays | PostgreSQL (products, carts, orders, coupons) |
| Cart lock | `Set` in memory | Redis `SET cart:{id}:lock NX EX 30` or `SELECT ... FOR UPDATE` |
| Idempotency | `Map` in memory | DB table with unique key constraint |
| Inventory | `product.inventory--` | `UPDATE ... SET inv = inv - ? WHERE inv >= ?` |
| Coupon gen | `lastGeneratedMilestone` | `INSERT ... ON CONFLICT DO NOTHING` on milestone |
| Report | JS loops | SQL aggregates (`SUM`, `COUNT`, `GROUP BY`) |
| Sessions | N/A | JWT stateless; sticky sessions not needed |

---

## AI Tool Usage

- **Claude Code** used for scaffolding, error class design, money module, test structure.
- **Correction example:** Initial money module used `Math.round` for discount; I changed to `Math.floor` to guarantee no over-discount and negative totals. Also corrected the store typo (`cools` → `coupons` array name) which was a hallucinated variable name.
- **Rejection example:** AI suggested optimistic locking with version columns for in-memory store — over-engineered for the demo. Rejected in favor of simple mutex + idempotency map.
- **Redirection:** AI proposed a full event-sourcing architecture; redirected to simple CRUD with explicit invariants per timebox.

---

## Next Two Hours: What I'd Examine First

1. **Inventory race under load** — Add k6/Locust script to hammer concurrent add-to-cart + checkout; verify zero oversell.
2. **Idempotency key leak** — Current map grows unbounded; add TTL cleanup or move to Redis with expiry.
3. **Coupon generation race** — If two admins POST simultaneously after milestone, both might see `generated: false` then one creates. Fix with DB unique constraint or Redis lock.
4. **Cart abandonment** — Add TTL job to return inventory of stale open carts (e.g., >24h).
5. **OpenAPI spec** — Generate from route handlers for client SDKs.
6. **Property-based tests** — Fast-check for money module invariants (discount ≤ subtotal, total ≥ 0, commutativity).