import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '../errors/app-error';
import { parseEtag } from './etag.util';

export const IF_MATCH_MESSAGE = 'Refresh the request and try again.';

export type IfMatchOptions = {
  /** Routes marked IM in the API contract: a missing header is a 422. */
  required?: boolean;
};

/**
 * Returns the expected version, or undefined when the header is absent and not
 * required (no version check). A malformed header is treated like a missing
 * required one. Status 428 is deliberately not used.
 */
export function parseIfMatch(
  header: string | string[] | undefined,
  options: IfMatchOptions = {},
): number | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined || raw.trim() === '') {
    if (options.required) {
      throw new AppError(422, 'VALIDATION_ERROR', IF_MATCH_MESSAGE);
    }
    return undefined;
  }
  const version = parseEtag(raw);
  if (version === null) {
    throw new AppError(422, 'VALIDATION_ERROR', IF_MATCH_MESSAGE);
  }
  return version;
}

export const IfMatch = createParamDecorator(
  (options: IfMatchOptions | undefined, context: ExecutionContext) =>
    parseIfMatch(
      context.switchToHttp().getRequest<Request>().headers['if-match'],
      options,
    ),
);
