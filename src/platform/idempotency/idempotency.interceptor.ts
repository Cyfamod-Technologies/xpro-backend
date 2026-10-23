import {
  applyDecorators,
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
  SetMetadata,
  UseInterceptors,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable, of } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import type { RequestUser } from '../../common/types/request-user';
import { parseIdempotencyKey } from './idempotency-key.decorator';
import { IdempotencyService } from './idempotency.service';

const IDEMPOTENCY_OPTIONS_KEY = 'platform:idempotency';

/**
 * Generic replay for simple routes. Request commands do not use this: the
 * RequestCommandRunner calls IdempotencyService directly inside its transaction.
 * The stored value is the handler's return value, before the response envelope,
 * so a replay goes through the same envelope as the original. Two concurrent
 * first requests with the same key can both run; only the first response is kept.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly idempotency: IdempotencyService,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const options =
      this.reflector.get<{ required?: boolean }>(
        IDEMPOTENCY_OPTIONS_KEY,
        context.getHandler(),
      ) ?? {};
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: RequestUser }>();
    const key = parseIdempotencyKey(req.headers['idempotency-key'], options);
    const actorId = req.user?.id;
    if (!key || !actorId) return next.handle();

    const hash = this.idempotency.hashRequest(
      req.method,
      req.originalUrl,
      req.body,
    );
    const stored = await this.idempotency.lookup(actorId, key, hash);
    if (stored) {
      http.getResponse<Response>().status(stored.status);
      return of(stored.body);
    }

    const status =
      (Reflect.getMetadata(HTTP_CODE_METADATA, context.getHandler()) as
        number | undefined) ??
      (req.method === 'POST' ? HttpStatus.CREATED : HttpStatus.OK);

    return next.handle().pipe(
      mergeMap(async (body: unknown) => {
        await this.idempotency.store(actorId, key, hash, status, body);
        return body;
      }),
    );
  }
}

/** Accept (or require) an `Idempotency-Key` on a route. Needs PlatformModule imported. */
export const Idempotent = (options: { required?: boolean } = {}) =>
  applyDecorators(
    SetMetadata(IDEMPOTENCY_OPTIONS_KEY, options),
    UseInterceptors(IdempotencyInterceptor),
  );
