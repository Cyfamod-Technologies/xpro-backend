import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Response } from 'express';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import {
  SUCCESS_RESPONSE_KEY,
  SuccessResponseOptions,
} from '../decorators/response.decorator';

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, unknown> {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options =
      this.reflector.getAllAndOverride<SuccessResponseOptions>(
        SUCCESS_RESPONSE_KEY,
        [context.getHandler(), context.getClass()],
      ) || {};

    return next.handle().pipe(
      map((data: unknown) => {
        const ctx = context.switchToHttp();
        const response = ctx.getResponse<Response>();

        // SSE and other streaming endpoints write directly to res and call
        // res.end() — skip wrapping when the response is already committed.
        if (response.headersSent) return data;

        const isObject =
          data !== null && typeof data === 'object' && !Array.isArray(data);
        const dataObj = isObject ? (data as Record<string, unknown>) : null;

        const statusCode =
          (dataObj?.statusCode as number | undefined) ??
          options.statusCode ??
          response.statusCode ??
          200;
        const isPrimitive =
          Array.isArray(data) ||
          typeof data === 'string' ||
          typeof data === 'number' ||
          typeof data === 'boolean';

        let payload: unknown;

        if (isPrimitive) {
          payload = data;
        } else if (dataObj) {
          const { statusCode: _s, message: _m, ...rest } = dataObj;
          payload = Object.keys(rest).length ? rest : null;
        } else {
          payload = null;
        }

        response.status(statusCode);

        if (statusCode === 204) return null;

        return { data: payload };
      }),
    );
  }
}
