/**
 * Money handling.
 *
 * All money is stored and computed as integer *cents*. This eliminates
 * floating-point rounding errors entirely (a 10% discount on $19.99 is
 * computed as 1999 * 10 / 100 = 199 cents, never 199.9 * 0.1).
 *
 * The API accepts prices in dollars (e.g. 19.99) and normalizes them to
 * cents on input. It returns dollars on output for readability.
 */

const CENTS_PER_DOLLAR = 100;

/** Parse a decimal dollar string/number into integer cents. */
function toCents(value) {
  if (value === null || value === undefined || value === '') {
    throw new Error('Money value is required');
  }
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || Number.isNaN(n)) {
    throw new Error(`Invalid money value: ${value}`);
  }
  // Round to nearest cent via banker's-free integer math: multiply, round.
  const cents = Math.round(n * CENTS_PER_DOLLAR);
  if (!Number.isSafeInteger(cents)) {
    throw new Error(`Money value out of range: ${value}`);
  }
  return cents;
}

/** Integer cents -> decimal dollars (2dp). */
function toDollars(cents) {
  return Number((cents / CENTS_PER_DOLLAR).toFixed(2));
}

/** Add two cent amounts. */
function add(a, b) {
  return a + b;
}

/** Subtract. */
function sub(a, b) {
  return a - b;
}

/** Multiply cents by an integer quantity. */
function mul(cents, quantity) {
  if (!Number.isSafeInteger(quantity) || quantity < 0) {
    throw new Error('Quantity must be a non-negative integer');
  }
  return cents * quantity;
}

/**
 * Apply a percentage discount to a cent amount.
 * discountPercent is an integer, e.g. 10 means 10%.
 * Uses integer truncation (floor) so the discount can never exceed the
 * subtotal and the total can never go negative.
 */
function discountAmount(subtotalCents, discountPercent) {
  if (subtotalCents < 0) throw new Error('Subtotal must be non-negative');
  if (discountPercent < 0 || discountPercent > 100) {
    throw new Error('Discount percent must be 0..100');
  }
  // floor: deterministic, never rounds up, never negative.
  return Math.floor((subtotalCents * discountPercent) / 100);
}

/** Final total after discount, clamped to >= 0. */
function totalAfterDiscount(subtotalCents, discountPercent) {
  const discount = discountAmount(subtotalCents, discountPercent);
  return Math.max(0, subtotalCents - discount);
}

module.exports = {
  CENTS_PER_DOLLAR,
  toCents,
  toDollars,
  add,
  sub,
  mul,
  discountAmount,
  totalAfterDiscount,
};