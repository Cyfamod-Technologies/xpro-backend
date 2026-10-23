import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '../errors/app-error';

export const IDEMPOTENCY_KEY_MIN = 8;
export const IDEMPOTENCY_KEY_MAX = 128;
export const IDEMPOTENCY_KEY_REQUIRED_MESSAGE =
  'Idempotency-Key header is required.';
export const IDEMPOTENCY_KEY_LENGTH_MESSAGE =
  'Idempotency-Key must be 8 to 128 characters.';

export type IdempotencyKeyOptions = { required?: boolean };

/**
 * Returns the trimmed key, or undefined when absent and not required.
 * Length outside 8..128 is a 422 VALIDATION_ERROR (new message: not in spec).
 */
export function parseIdempotencyKey(
  header: string | string[] | undefined,
  options: IdempotencyKeyOptions = {},
): string | undefined {
  const raw = (Array.isArray(header) ? header[0] : header)?.trim();
  if (!raw) {
    if (options.required) {
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        IDEMPOTENCY_KEY_REQUIRED_MESSAGE,
      );
    }
    return undefined;
  }
  if (raw.length < IDEMPOTENCY_KEY_MIN || raw.length > IDEMPOTENCY_KEY_MAX) {
    throw new AppError(422, 'VALIDATION_ERROR', IDEMPOTENCY_KEY_LENGTH_MESSAGE);
  }
  return raw;
}

export const IdempotencyKey = createParamDecorator(
  (options: IdempotencyKeyOptions | undefined, context: ExecutionContext) =>
    parseIdempotencyKey(
      context.switchToHttp().getRequest<Request>().headers['idempotency-key'],
      options,
    ),
);
