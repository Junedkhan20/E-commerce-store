/**
 * Domain error types.
 *
 * Each error carries an `httpStatus` and a stable `code` so API clients can
 * branch on the failure reason without parsing prose. Errors are
 * distinguishable by kind (validation vs conflict vs not-found vs business-rule),
 * which is what the README asks for.
 */

class AppError extends Error {
  constructor({ code, message, httpStatus, details }) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.httpStatus = httpStatus;
    if (details !== undefined) this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

// 4xx client errors
class ValidationError extends AppError {
  constructor(message, details) {
    super({ code: 'VALIDATION_ERROR', message, httpStatus: 400, details });
  }
}

class NotFoundError extends AppError {
  constructor(message) {
    super({ code: 'NOT_FOUND', message, httpStatus: 404 });
  }
}

class ConflictError extends AppError {
  constructor(message, details) {
    super({ code: 'CONFLICT', message, httpStatus: 409, details });
  }
}

class CouponError extends AppError {
  constructor(message, details) {
    super({ code: 'COUPON_ERROR', message, httpStatus: 422, details });
  }
}

module.exports = {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  CouponError,
};