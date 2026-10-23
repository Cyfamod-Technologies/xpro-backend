import { HttpException } from '@nestjs/common';
import type { ErrorCode } from './error-codes';

/**
 * Domain error carrying an explicit code. `ExceptionLoggingFilter` renders it as
 * `{ error: { code, message, details? } }`.
 *
 * Status mapping (spec 06 §11.1): 422 VALIDATION_ERROR and IDEMPOTENCY_KEY_REUSED,
 * 409 STATE_CONFLICT, VERSION_CONFLICT and PAYMENT_IN_PROGRESS, 403 FORBIDDEN,
 * 404 NOT_FOUND, 429 RATE_LIMITED. Every 409 should carry `details.current`.
 */
export class AppError extends HttpException {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super({ code, message, ...(details ? { details } : {}) }, status);
    this.code = code;
    this.details = details;
  }
}
