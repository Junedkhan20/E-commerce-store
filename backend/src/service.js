/**
 * Business logic layer (service).
 *
 * All invariants are enforced here, not in controllers, so they are
 * testable independently of HTTP. Controllers only translate HTTP to
 * service calls and back.
 */

const { ValidationError, NotFoundError, ConflictError, CouponError } = require('./errors');
const { toCents, toDollars, add, mul, discountAmount, totalAfterDiscount } = require('./money');

function createService(store) {
  // Seed data at startup
  store.seedProducts([
    { id: 'p1', name: 'Wireless Headphones', priceCents: 4999, inventory: 10 },
    { id: 'p2', name: 'Mechanical Keyboard', priceCents: 8999, inventory: 5 },  // limited
    { id: 'p3', name: 'USB-C Hub', priceCents: 2499, inventory: 25 },
    { id: 'p4', name: 'Webcam 1080p', priceCents: 6999, inventory: 8 },
    { id: 'p5', name: 'Laptop Stand', priceCents: 3599, inventory: 15 },
  ]);

  // --- Cart operations ---

  function createCart() {
    return store.createCart();
  }

  function getCart(cartId) {
    const cart = store.getCart(cartId);
    if (!cart) throw new NotFoundError('Cart not found');
    return enrichCart(cart);
  }

  function addItem(cartId, productId, qty) {
    if (!Number.isInteger(qty) || qty < 1) {
      throw new ValidationError('Quantity must be a positive integer');
    }
    const cart = store.getCart(cartId);
    if (!cart) throw new NotFoundError('Cart not found');
    if (cart.status !== 'open') throw new ConflictError('Cart already checked out');
    const product = store.getProduct(productId);
    if (!product) throw new NotFoundError('Product not found');
    // Price/availability at add-to-cart: use current values (documented in DECISIONS.md)
    if (product.inventory < qty) {
      throw new ValidationError(`Not enough inventory: available ${product.inventory}, requested ${qty}`);
    }
    // Update cart item or add new
    const existing = cart.items.find(i => i.productId === productId);
    if (existing) {
      existing.qty += qty;
    } else {
      cart.items.push({ productId, qty, priceCents: product.priceCents, name: product.name });
    }
    // Deduct inventory immediately to prevent oversell across concurrent adds
    // (alternative: reserve in cart; this is simpler and correct for demo)
    product.inventory -= qty;
    return enrichCart(cart);
  }

  function updateItem(cartId, productId, qty) {
    if (!Number.isInteger(qty) || qty < 1) {
      throw new ValidationError('Quantity must be a positive integer');
    }
    const cart = store.getCart(cartId);
    if (!cart) throw new NotFoundError('Cart not found');
    if (cart.status !== 'open') throw new ConflictError('Cart already checked out');
    const existing = cart.items.find(i => i.productId === productId);
    if (!existing) throw new NotFoundError('Item not in cart');
    const product = store.getProduct(productId);
    if (!product) throw new NotFoundError('Product not found');

    // Adjust inventory: return old qty, deduct new qty
    const oldQty = existing.qty;
    const delta = qty - oldQty;
    if (delta > 0 && product.inventory < delta) {
      throw new ValidationError(`Not enough inventory for update: available ${product.inventory}`);
    }
    product.inventory -= delta;
    existing.qty = qty;
    // Price update: capture price at the time of update if changed
    existing.priceCents = product.priceCents;
    existing.name = product.name;
    return enrichCart(cart);
  }

  function removeItem(cartId, productId) {
    const cart = store.getCart(cartId);
    if (!cart) throw new NotFoundError('Cart not found');
    if (cart.status !== 'open') throw new ConflictError('Cart already checked out');
    const idx = cart.items.findIndex(i => i.productId === productId);
    if (idx === -1) throw new NotFoundError('Item not in cart');
    const item = cart.items[idx];
    // Return inventory
    const product = store.getProduct(productId);
    if (product) product.inventory += item.qty;
    cart.items.splice(idx, 1);
    return enrichCart(cart);
  }

  // --- Checkout ---

  function checkout(cartId, idempotencyKey = null, couponCode = null) {
    // 1. Idempotency: if same key already produced an order, return it.
    //    Checked BEFORE the cart-status check so a retry after a successful
    //    checkout returns the existing order instead of a 409 Conflict.
    if (idempotencyKey) {
      const prev = store.getIdempotency(idempotencyKey);
      if (prev) {
        const order = store.getOrder(prev);
        if (order) return { order };
      }
    }

    // 2. Cart exists and open
    const cart = store.getCart(cartId);
    if (!cart) throw new NotFoundError('Cart not found');
    if (cart.status !== 'open') throw new ConflictError('Cart already checked out');

    // 3. Lock cart for concurrent checkout attempts
    if (!store.acquireCheckoutLock(cartId)) {
      throw new ConflictError('Checkout already in progress for this cart; retry with same idempotency key');
    }

    try {
      // Re-verify cart after lock (concurrent mutation could have occurred)
      const freshCart = store.getCart(cartId);
      if (freshCart.status !== 'open') throw new ConflictError('Cart already checked out');

      // 4. Validate items: products still exist, enough inventory.
      //    Inventory was deducted at add-to-cart; here we verify no negative.
      for (const it of freshCart.items) {
        const prod = store.getProduct(it.productId);
        if (!prod) throw new ValidationError(`Product ${it.productId} no longer available`);
        // Inventory should never go negative; guard anyway.
        if (prod.inventory < 0) {
          throw new ValidationError(`Inventory corruption for ${prod.name}`);
        }
      }

      // 5. Coupon validation (must not be consumed if checkout fails)
      let coupon = null;
      let discountPercent = 0;
      if (couponCode) {
        coupon = store.coupons.find(c => c.code === couponCode);
        if (!coupon) throw new CouponError('Invalid coupon');
        if (coupon.redeemed) throw new CouponError('Coupon already redeemed');
        discountPercent = coupon.percent;
      }

      // 6. Calculate total using integer cents
      let subtotalCents = 0;
      const orderItems = [];
      for (const it of freshCart.items) {
        const prod = store.getProduct(it.productId);
        // At checkout we compute with current price (documented choice)
        const itemTotalCents = mul(prod.priceCents, it.qty);
        subtotalCents = add(subtotalCents, itemTotalCents);
        orderItems.push({
          productId: it.productId,
          name: prod.name,
          qty: it.qty,
          unitPriceCents: prod.priceCents,
          lineTotalCents: itemTotalCents,
        });
      }

      const totalCents = totalAfterDiscount(subtotalCents, discountPercent);
      if (totalCents < 0) throw new Error('Total went negative (should not happen)');

      const orderId = 'ord-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);

      // 7. Create order
      const order = {
        id: orderId,
        cartId,
        items: orderItems,
        subtotalCents,
        discountPercent,
        discountCents: discountAmount(subtotalCents, discountPercent),
        totalCents,
        couponCode: coupon ? coupon.code : null,
        createdAt: new Date().toISOString(),
      };
      store.orders.push(order);

      // 8. Redeem coupon atomically (only after order created)
      if (coupon) {
        coupon.redeemed = true;
        coupon.redeemedForOrderId = orderId;
      }

      // 9. Mark cart checked out
      freshCart.status = 'checked_out';
      freshCart.orderId = orderId;

      // 10. Update milestone tracking for coupon generation
      store.config.currentMilestoneOrders += 1;

      // 11. Store idempotency
      if (idempotencyKey) {
        store.setIdempotency(idempotencyKey, orderId);
      }

      return { order: enrichOrder(order) };
    } finally {
      store.releaseCheckoutLock(cartId);
    }
  }

  // --- Coupon admin ---

  function generateCoupon() {
    const cfg = store.getConfig();
    const milestone = Math.floor(cfg.currentMilestoneOrders / cfg.n) * cfg.n;
    if (milestone === cfg.lastGeneratedMilestone) {
      return { generated: false, reason: 'Milestone already rewarded' };
    }
    const code = 'COUPON-' + milestone + '-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    store.coupons.push({
      code,
      percent: cfg.x,
      generatedForMilestone: milestone,
      redeemed: false,
      redeemedForOrderId: null,
      createdAt: new Date().toISOString(),
    });
    store.config.lastGeneratedMilestone = milestone;
    return { generated: true, coupon: { code, percent: cfg.x } };
  }

  // --- Report ---

  function getReport() {
    const orders = store.getOrders();
    let totalQuantityByProduct = {};
    let grossRevenueCents = 0;
    let discountsCents = 0;
    let netRevenueCents = 0;
    for (const o of orders) {
      grossRevenueCents += o.subtotalCents;
      discountsCents += o.discountCents || 0;
      netRevenueCents += o.totalCents;
      for (const it of o.items) {
        totalQuantityByProduct[it.productId] = (totalQuantityByProduct[it.productId] || 0) + it.qty;
      }
    }
    const coupons = store.getCoupons();
    const generated = coupons.length;
    const available = coupons.filter(c => !c.redeemed).length;
    const redeemed = coupons.filter(c => c.redeemed).length;

    return {
      totalOrders: orders.length,
      quantityByProduct: totalQuantityByProduct,
      grossRevenue: toDollars(grossRevenueCents),
      totalDiscounts: toDollars(discountsCents),
      netRevenue: toDollars(netRevenueCents),
      couponsGenerated: generated,
      couponsAvailable: available,
      couponsRedeemed: redeemed,
      orders: orders.map(o => ({
        id: o.id,
        total: toDollars(o.totalCents),
        coupon: o.couponCode,
        createdAt: o.createdAt,
      })),
      coupons: coupons.map(c => ({
        code: c.code,
        percent: c.percent,
        redeemed: c.redeemed,
        redeemedForOrder: c.redeemedForOrderId,
      })),
    };
  }

function enrichOrder(order) {
    return {
      id: order.id,
      cartId: order.cartId,
      items: order.items.map(it => ({ ...it, unitPrice: toDollars(it.unitPriceCents), lineTotal: toDollars(it.lineTotalCents) })),
      subtotal: toDollars(order.subtotalCents),
      discountPercent: order.discountPercent,
      discount: toDollars(order.discountCents || 0),
      total: toDollars(order.totalCents),
      couponCode: order.couponCode,
      createdAt: order.createdAt,
    };
  }

  // --- Helper: enrich cart with totals ---

  function enrichCart(cart) {
    let subtotalCents = 0;
    const items = cart.items.map(it => {
      const lineTotal = mul(it.priceCents, it.qty);
      subtotalCents = add(subtotalCents, lineTotal);
      return {
        productId: it.productId,
        name: it.name,
        qty: it.qty,
        unitPrice: toDollars(it.priceCents),
        lineTotal: toDollars(lineTotal),
      };
    });
    return {
      id: cart.id,
      status: cart.status,
      items,
      subtotal: toDollars(subtotalCents),
      createdAt: cart.createdAt,
      ...(cart.orderId ? { orderId: cart.orderId } : {}),
    };
  }

  return {
    createCart,
    getCart,
    addItem,
    updateItem,
    removeItem,
    checkout,
    generateCoupon,
    getReport,
    getOrders: () => store.getOrders(),
    getCoupons: () => store.getCoupons(),
    getConfig: () => store.getConfig(),
    enrichOrder,
  };
}

module.exports = { createService };
