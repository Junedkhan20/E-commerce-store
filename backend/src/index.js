/**
 * HTTP API.
 *
 * Each endpoint validates, calls the service, and formats responses.
 * Errors from the service (ValidationError, ConflictError, etc.) are caught
 * by the error handler and returned with proper status codes and stable codes.
 */

const express = require('express');
const cors = require('cors');
const { createService } = require('./service');
const { Store } = require('./store');
const { AppError } = require('./errors');

// Catch validation errors from request body parsing
function handleValidation(err, req, res, next) {
  if (err.type === 'entity.too_large' || (err.statusCode && err.statusCode === 400)) {
    return res.status(400).json({
      error: { code: 'BAD_REQUEST', message: 'Invalid request body' },
    });
  }
  next(err);
}

function buildApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use(handleValidation);

  app.use(express.static('../frontend'));

  const store = new Store();
  const svc = createService(store);

  // ----- Health -----
  app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

  // ----- Products -----
  app.get('/products', (req, res) => {
    res.json({ products: store.getAllProducts().map(p => ({
      id: p.id, name: p.name, price: p.priceCents / 100, inventory: p.inventory,
    })) });
  });

  // ----- Carts -----
  app.post('/carts', (req, res) => {
    const cart = svc.createCart();
    res.status(201).json({ cart: { id: cart.id, status: cart.status, items: [], subtotal: 0 } });
  });

  app.get('/carts/:cartId', (req, res) => {
    const cart = svc.getCart(req.params.cartId);
    res.json({ cart });
  });

  app.post('/carts/:cartId/items', (req, res) => {
    const { productId, qty = 1 } = req.body || {};
    if (!productId) throw new Error('productId required');
    const cart = svc.addItem(req.params.cartId, productId, qty);
    res.json({ cart });
  });

  app.put('/carts/:cartId/items/:productId', (req, res) => {
    const { qty } = req.body || {};
    const cart = svc.updateItem(req.params.cartId, req.params.productId, qty);
    res.json({ cart });
  });

  app.delete('/carts/:cartId/items/:productId', (req, res) => {
    const cart = svc.removeItem(req.params.cartId, req.params.productId);
    res.json({ cart });
  });

  // ----- Checkout -----
  app.post('/carts/:cartId/checkout', (req, res) => {
    const { idempotencyKey, couponCode } = req.body || {};
    const result = svc.checkout(req.params.cartId, idempotencyKey, couponCode);
    res.json({ order: result.order || result });
  });

  // ----- Orders -----
  app.get('/orders/:orderId', (req, res) => {
    const order = store.getOrder(req.params.orderId);
    if (!order) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found' } });
    res.json({ order: {
      id: order.id,
      cartId: order.cartId,
      items: order.items,
      subtotal: order.subtotalCents / 100,
      discountPercent: order.discountPercent,
      discount: (order.discountCents || 0) / 100,
      total: order.totalCents / 100,
      couponCode: order.couponCode,
      createdAt: order.createdAt,
    }});
  });

  // ----- Admin -----
  app.post('/admin/coupons/generate', (req, res) => {
    const result = svc.generateCoupon();
    res.json({ ...result });
  });

  app.get('/admin/report', (req, res) => {
    res.json({ report: svc.getReport() });
  });

  // ----- Error handler -----
  app.use((err, req, res, next) => {
    // If it's an AppError, use its status and code
    if (err instanceof AppError) {
      return res.status(err.httpStatus).json({
        error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) },
      });
    }
    // Generic unexpected errors
    console.error('Unexpected error:', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' } });
  });

  return app;
}

// Start server if called directly
if (require.main === module) {
  const app = buildApp();
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Uniblox backend running on port ${PORT}`));
}

module.exports = { buildApp };
