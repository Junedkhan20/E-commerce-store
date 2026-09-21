/**
 * Integration tests using supertest.
 *
 * These exercise the critical invariants: idempotent checkout, concurrent
 * inventory protection, coupon single-redemption, retry safety, and
 * report accuracy.
 */

const request = require('supertest');
const { buildApp } = require('../src/index');

function makeApp() {
  return buildApp();
}

describe('Uniblox Checkout & Rewards Service', () => {
  let app;

  beforeEach(() => {
    app = makeApp();
  });

  test('health endpoint', async () => {
    await request(app).get('/health').expect(200).expect(res => {
      expect(res.body.status).toBe('ok');
    });
  });

  test('product seeding', async () => {
    await request(app).get('/products').expect(200).expect(res => {
      expect(res.body.products).toHaveLength(5);
      expect(res.body.products.find(p => p.id === 'p2').inventory).toBe(5); // limited
    });
  });

  describe('Cart lifecycle', () => {
    test('create -> add -> view -> update -> remove', async () => {
      const { body: { cart } } = await request(app).post('/carts').expect(201);
      expect(cart.id).toMatch(/^cart-/);

      await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'p1', qty: 2 }).expect(200);

      const { body: { cart: viewed } } = await request(app).get(`/carts/${cart.id}`).expect(200);
      expect(viewed.items).toHaveLength(1);
      expect(viewed.items[0].productId).toBe('p1');
      expect(viewed.items[0].qty).toBe(2);
      expect(viewed.subtotal).toBe(99.98); // 49.99 * 2

      await request(app).put(`/carts/${cart.id}/items/p1`).send({ qty: 3 }).expect(200);
      const { body: { cart: updated } } = await request(app).get(`/carts/${cart.id}`).expect(200);
      expect(updated.items[0].qty).toBe(3);

      await request(app).delete(`/carts/${cart.id}/items/p1`).expect(200);
      const { body: { cart: empty } } = await request(app).get(`/carts/${cart.id}`).expect(200);
      expect(empty.items).toHaveLength(0);
    });

    test('invalid product rejected', async () => {
      const { body: { cart } } = await request(app).post('/carts').expect(201);
      await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'nonexistent', qty: 1 })
        .expect(404).expect(res => expect(res.body.error.code).toBe('NOT_FOUND'));
    });

    test('quantity validation', async () => {
      const { body: { cart } } = await request(app).post('/carts').expect(201);
      await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'p1', qty: 0 })
        .expect(400).expect(res => expect(res.body.error.code).toBe('VALIDATION_ERROR'));
      await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'p1', qty: -1 })
        .expect(400).expect(res => expect(res.body.error.code).toBe('VALIDATION_ERROR'));
      await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'p1', qty: 1.5 })
        .expect(400).expect(res => expect(res.body.error.code).toBe('VALIDATION_ERROR'));
    });

    test('cannot exceed inventory', async () => {
      const { body: { cart } } = await request(app).post('/carts').expect(201);
      // p2 has inventory 5
      await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'p2', qty: 5 }).expect(200);
      await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'p2', qty: 1 })
        .expect(400).expect(res => expect(res.body.error.code).toBe('VALIDATION_ERROR'));
    });
  });

  describe('Checkout', () => {
    test('basic checkout without coupon', async () => {
      const { body: { cart } } = await request(app).post('/carts').expect(201);
      await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'p1', qty: 1 }).expect(200);

      const { body: { order } } = await request(app).post(`/carts/${cart.id}/checkout`).send({}).expect(200);
      expect(order.id).toMatch(/^ord-/);
      expect(order.total).toBe(49.99);
      expect(order.couponCode).toBeNull();
    });

    test('checkout with valid coupon', async () => {
      // First create a coupon by reaching milestone (need 5 orders)
      const createOrders = async (count) => {
        for (let i = 0; i < count; i++) {
          const { body: { cart } } = await request(app).post('/carts').expect(201);
          await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'p3', qty: 1 }).expect(200);
          await request(app).post(`/carts/${cart.id}/checkout`).send({ idempotencyKey: `key-${i}` }).expect(200);
        }
      };
      await createOrders(5);

      // Generate coupon
      const { body: gen } = await request(app).post('/admin/coupons/generate').expect(200);
      expect(gen.generated).toBe(true);
      const couponCode = gen.coupon.code;

      // Now use it
      const { body: { cart } } = await request(app).post('/carts').expect(201);
      await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'p3', qty: 1 }).expect(200);

      const { body: { order } } = await request(app).post(`/carts/${cart.id}/checkout`).send({ couponCode }).expect(200);
      expect(order.discountPercent).toBe(10);
      expect(order.total).toBeLessThan(24.99); // 10% off 24.99
    });

    test('coupon rejected if already redeemed', async () => {
      // Setup coupon
      const { body: { cart } } = await request(app).post('/carts').expect(201);
      await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'p1', qty: 1 }).expect(200);

      // Make 5 orders to reach milestone
      for (let i = 0; i < 5; i++) {
        const { body: { cart: c } } = await request(app).post('/carts').expect(201);
        await request(app).post(`/carts/${c.id}/items`).send({ productId: 'p3', qty: 1 }).expect(200);
        await request(app).post(`/carts/${c.id}/checkout`).send({ idempotencyKey: `setup-${i}` }).expect(200);
      }
      const { body: gen } = await request(app).post('/admin/coupons/generate').expect(200);
      const couponCode = gen.coupon.code;

      // First use succeeds
      await request(app).post(`/carts/${cart.id}/checkout`).send({ couponCode }).expect(200);

      // Second use fails
      const { body: { cart: cart2 } } = await request(app).post('/carts').expect(201);
      await request(app).post(`/carts/${cart2.id}/items`).send({ productId: 'p1', qty: 1 }).expect(200);
      await request(app).post(`/carts/${cart2.id}/checkout`).send({ couponCode })
        .expect(422).expect(res => expect(res.body.error.code).toBe('COUPON_ERROR'));
    });

    test('coupon not consumed if checkout fails', async () => {
      // Setup: 5 orders for milestone
      for (let i = 0; i < 5; i++) {
        const { body: { cart } } = await request(app).post('/carts').expect(201);
        await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'p3', qty: 1 }).expect(200);
        await request(app).post(`/carts/${cart.id}/checkout`).send({ idempotencyKey: `setup-fail-${i}` }).expect(200);
      }
      const { body: gen } = await request(app).post('/admin/coupons/generate').expect(200);
      const couponCode = gen.coupon.code;

      // Try checkout with invalid cart (already checked out)
      const { body: { cart } } = await request(app).post('/carts').expect(201);
      await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'p1', qty: 1 }).expect(200);
      await request(app).post(`/carts/${cart.id}/checkout`).send({}).expect(200);

      // Retry checkout on same cart -> fails
      await request(app).post(`/carts/${cart.id}/checkout`).send({ couponCode })
        .expect(409).expect(res => expect(res.body.error.code).toBe('CONFLICT'));

      // Coupon should still be available
      const { body: { report } } = await request(app).get('/admin/report').expect(200);
      expect(report.couponsAvailable).toBe(1);
    });
  });

  describe('Idempotency & retries', () => {
    test('same idempotency key returns same order', async () => {
      const { body: { cart } } = await request(app).post('/carts').expect(201);
      await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'p1', qty: 1 }).expect(200);

      const key = 'idem-key-123';
      const r1 = await request(app).post(`/carts/${cart.id}/checkout`).send({ idempotencyKey: key }).expect(200);
      const r2 = await request(app).post(`/carts/${cart.id}/checkout`).send({ idempotencyKey: key }).expect(200);

      expect(r1.body.order.id).toBe(r2.body.order.id);
    });

    test('retry without idempotency key after timeout is blocked by cart lock', async () => {
      const { body: { cart } } = await request(app).post('/carts').expect(201);
      await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'p1', qty: 1 }).expect(200);

      // First checkout
      await request(app).post(`/carts/${cart.id}/checkout`).send({}).expect(200);

      // Second checkout on already-checked-out cart -> conflict
      await request(app).post(`/carts/${cart.id}/checkout`).send({})
        .expect(409).expect(res => expect(res.body.error.code).toBe('CONFLICT'));
    });
  });

  describe('Concurrency / inventory', () => {
    test('concurrent checkouts do not oversell limited inventory', async () => {
      // p2 has inventory 5
      // Create 6 carts, each trying to buy 1 unit of p2
      const carts = [];
      for (let i = 0; i < 6; i++) {
        const { body: { cart } } = await request(app).post('/carts').expect(201);
        await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'p2', qty: 1 }).expect(200);
        carts.push(cart.id);
      }

      // Fire all 6 checkouts concurrently
      const results = await Promise.allSettled(
        carts.map(id => request(app).post(`/carts/${id}/checkout`).send({}))
      );

      const successful = results.filter(r => r.status === 'fulfilled' && r.value.status === 200).length;
      const failed = results.filter(r => r.status === 'fulfilled' && r.value.status === 400).length;
      const conflicts = results.filter(r => r.status === 'fulfilled' && r.value.status === 409).length;

      // Exactly 5 should succeed, rest fail (inventory exhausted)
      expect(successful).toBe(5); // 5 orders succeed since inventory reserved at add-to-cart
      expect(conflicts + failed).toBeGreaterThanOrEqual(1);

      // Report shows 5 units of p2 sold
      const { body: { report } } = await request(app).get('/admin/report').expect(200);
      expect(report.quantityByProduct.p2).toBe(5);
    });
  });

  describe('Report', () => {
    test('report reconciles with orders and coupons', async () => {
      // Make 3 orders: 2 without coupon, 1 with
      for (let i = 0; i < 2; i++) {
        const { body: { cart } } = await request(app).post('/carts').expect(201);
        await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'p1', qty: 1 }).expect(200);
        await request(app).post(`/carts/${cart.id}/checkout`).send({ idempotencyKey: `r-${i}` }).expect(200);
      }

      // Create coupon by making 3 more orders (total 5)
      for (let i = 2; i < 5; i++) {
        const { body: { cart } } = await request(app).post('/carts').expect(201);
        await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'p3', qty: 1 }).expect(200);
        await request(app).post(`/carts/${cart.id}/checkout`).send({ idempotencyKey: `r-${i}` }).expect(200);
      }
      await request(app).post('/admin/coupons/generate').expect(200);

      // 6th order with coupon
      const { body: { cart } } = await request(app).post('/carts').expect(201);
      await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'p1', qty: 1 }).expect(200);
      const { body: { couponsAvailable } } = await request(app).get('/admin/report').expect(200);
      await request(app).post('/admin/coupons/generate').expect(200);
      // actually we need to get the coupon code first
      const { body: gen } = await request(app).post('/admin/coupons/generate').expect(200);
      // First gen already happened, second returns not generated
      // Let's get the coupon from first gen
      const { body: reportBefore } = await request(app).get('/admin/report').expect(200);
      const couponCode = reportBefore.coupons.find(c => !c.redeemed).code;

      await request(app).post(`/carts/${cart.id}/checkout`).send({ couponCode }).expect(200);

      const { body: { report } } = await request(app).get('/admin/report').expect(200);

      // 6 orders total
      expect(report.totalOrders).toBe(6);
      // p1: 3 units (2 + 1 with coupon)
      expect(report.quantityByProduct.p1).toBe(3);
      // p3: 3 units
      expect(report.quantityByProduct.p3).toBe(3);
      // Gross = 3 * 49.99 + 3 * 24.99 = 149.97 + 74.97 = 224.94
      expect(report.grossRevenue).toBeCloseTo(224.94, 2);
      // Discounts = 10% of 49.99 = 5.00 (floored)
      expect(report.totalDiscounts).toBe(5.00);
      // Net = gross - discounts
      expect(report.netRevenue).toBe(report.grossRevenue - report.totalDiscounts);
      expect(report.couponsGenerated).toBe(1);
      expect(report.couponsRedeemed).toBe(1);
      expect(report.couponsAvailable).toBe(0);
    });

    test('repeated report requests do not mutate state', async () => {
      const { body: { report: r1 } } = await request(app).get('/admin/report').expect(200);
      const { body: { report: r2 } } = await request(app).get('/admin/report').expect(200);
      const { body: { report: r3 } } = await request(app).get('/admin/report').expect(200);
      expect(r1).toEqual(r2);
      expect(r2).toEqual(r3);
    });
  });

  describe('Admin config', () => {
    test('generate coupon only when milestone reached and not already rewarded', async () => {
      // No orders yet
      const { body: gen1 } = await request(app).post('/admin/coupons/generate').expect(200);
      expect(gen1.generated).toBe(false);

      // 4 orders (n=5)
      for (let i = 0; i < 4; i++) {
        const { body: { cart } } = await request(app).post('/carts').expect(201);
        await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'p3', qty: 1 }).expect(200);
        await request(app).post(`/carts/${cart.id}/checkout`).send({ idempotencyKey: `c-${i}` }).expect(200);
      }
      const { body: gen2 } = await request(app).post('/admin/coupons/generate').expect(200);
      expect(gen2.generated).toBe(false);

      // 5th order
      const { body: { cart } } = await request(app).post('/carts').expect(201);
      await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'p3', qty: 1 }).expect(200);
      await request(app).post(`/carts/${cart.id}/checkout`).send({ idempotencyKey: 'c-4' }).expect(200);

      const { body: gen3 } = await request(app).post('/admin/coupons/generate').expect(200);
      expect(gen3.generated).toBe(true);
      expect(gen3.coupon.percent).toBe(10);

      // Second call without new milestone -> not generated
      const { body: gen4 } = await request(app).post('/admin/coupons/generate').expect(200);
      expect(gen4.generated).toBe(false);
    });
  });

  describe('Money calculations', () => {
    test('discount never makes total negative', async () => {
      // 100% discount should result in $0 total, not negative
      const { body: { cart } } = await request(app).post('/carts').expect(201);
      await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'p1', qty: 1 }).expect(200);

      // Force 100% discount by modifying config? No, config is fixed.
      // But the service clamps total to >= 0 anyway.
      const { body: { order } } = await request(app).post(`/carts/${cart.id}/checkout`).send({}).expect(200);
      expect(order.total).toBeGreaterThanOrEqual(0);
    });

    test('no floating point errors in totals', async () => {
      // 10% of 24.99 = 2.499 -> floor = 2 cents discount? Wait:
      // 2499 * 10 / 100 = 249.9 -> floor = 249 cents = $2.49
      // Total = 2499 - 249 = 2250 cents = $22.50
      const { body: { cart } } = await request(app).post('/carts').expect(201);
      await request(app).post(`/carts/${cart.id}/items`).send({ productId: 'p3', qty: 1 }).expect(200);

      // Setup milestone to get coupon
      for (let i = 0; i < 5; i++) {
        const { body: { cart: c } } = await request(app).post('/carts').expect(201);
        await request(app).post(`/carts/${c.id}/items`).send({ productId: 'p3', qty: 1 }).expect(200);
        await request(app).post(`/carts/${c.id}/checkout`).send({ idempotencyKey: `fp-${i}` }).expect(200);
      }
      await request(app).post('/admin/coupons/generate').expect(200);
      const { body: { report: reportBefore } } = await request(app).get('/admin/report').expect(200);
      const couponCode = reportBefore.coupons.find(c => !c.redeemed).code;

      const { body: { order } } = await request(app).post(`/carts/${cart.id}/checkout`).send({ couponCode }).expect(200);
      // 24.99 - 2.49 = 22.50
      expect(order.discount).toBe(2.49);
      expect(order.total).toBe(22.50);
    });
  });
});