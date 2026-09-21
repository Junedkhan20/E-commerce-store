/**
 * In-memory persistence with concurrency controls.
 *
 * This demonstrates how invariants are preserved when requests overlap.
 * With a production database the design changes as follows:
 * - Replace per-entity locks with DB-level transactions (SELECT FOR UPDATE,
 *   or optimistic version columns).
 * - Replace the global `checkoutLocks` map with a distributed lock service
 *   (Redis Redlock, DynamoDB conditional writes, or DB advisory locks) so
 *   retries survive across instances.
 * - In-memory arrays become tables (products, carts, orders, coupons) with
 *   foreign keys and unique constraints (e.g. coupon.code UNIQUE).
 * - Report calculations move to SQL aggregates rather than JS loops.
 *
 * Invariants enforced here:
 * 1. Inventory never negative (checked at add-to-cart and checkout).
 * 2. Cart checked out at most once (checked at checkout + idempotency key).
 * 3. Order created at most once per idempotency key (stored in orders).
 * 4. Coupon redeemed at most once (redeemed flag, set atomically).
 * 5. Coupon generated only for unrewarded milestones (milestone tracking).
 * 6. Money never negative (totalAfterDiscount clamps).
 */

class Store {
  constructor() {
    // Products: Array<{id, name, priceCents, inventory}>
    this.products = [];
    // Carts: Array<{id, items: [{productId, qty}], status: 'open'|'checked_out', orderId?, createdAt}>
    this.carts = [];
    // Orders: Array<{id, cartId, items, subtotalCents, discountPercent?, discountCents, totalCents, couponCode?, createdAt}>
    this.orders = [];
    // Coupons: Array<{code, percent, generatedForMilestone, redeemed: bool, redeemedForOrderId?, createdAt}>
    this.coupons = [];
    // Milestones: number of orders required to generate a coupon; reward %
    this.config = { n: 5, x: 10, currentMilestoneOrders: 0, lastGeneratedMilestone: 0 };
    // Idempotency keys (checkout retries): Map<key, orderId>
    this.idempotency = new Map();
    // Checkout concurrency locks by cartId to prevent double-checkout
    this.checkoutLocks = new Set();
  }

  // --- Product access ---
  seedProducts(list) {
    for (const p of list) {
      if (!p.id || !p.name || typeof p.priceCents !== 'number' || typeof p.inventory !== 'number') {
        throw new Error('Invalid seed product');
      }
      this.products.push({ ...p, priceCents: Math.round(p.priceCents) });
    }
  }

  getProduct(id) {
    return this.products.find(p => p.id === id) || null;
  }

  getAllProducts() {
    return this.products.map(p => ({ ...p }));
  }

  // --- Cart access ---
  createCart() {
    const id = 'cart-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const cart = { id, items: [], status: 'open', createdAt: new Date().toISOString() };
    this.carts.push(cart);
    return cart;
  }

  getCart(id) {
    return this.carts.find(c => c.id === id) || null;
  }

  // --- Order access ---
  getOrder(id) {
    return this.orders.find(o => o.id === id) || null;
  }

  getOrders() {
    return this.orders.map(o => ({ ...o }));
  }

  // --- Coupon access ---
  getCoupons() {
    return this.coupons.map(c => ({ ...c }));
  }

  getAvailableCoupons() {
    return this.coupons.filter(c => !c.redeemed).map(c => ({ ...c }));
  }

  // --- Config ---
  getConfig() {
    return { ...this.config };
  }

  // --- Concurrency helpers ---
  // Lock a cart for checkout; returns true if acquired.
  acquireCheckoutLock(cartId) {
    if (this.checkoutLocks.has(cartId)) return false;
    this.checkoutLocks.add(cartId);
    return true;
  }

  releaseCheckoutLock(cartId) {
    this.checkoutLocks.delete(cartId);
  }

  // Idempotency key lookup
  getIdempotency(key) {
    return this.idempotency.get(key) || null;
  }

  setIdempotency(key, orderId) {
    this.idempotency.set(key, orderId);
  }
}

module.exports = { Store };
