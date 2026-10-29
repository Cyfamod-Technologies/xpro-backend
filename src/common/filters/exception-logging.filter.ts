import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { discordAlert } from '../utils/discord-alert';

@Catch()
export class ExceptionLoggingFilter implements ExceptionFilter {
  private readonly logger = new Logger(ExceptionLoggingFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (response.headersSent) return;

    const service = process.env.SERVICE || 'Xpro API';
    const timestamp = new Date().toISOString();
    const status =
      exception instanceof HttpException ? exception.getStatus() : 500;

    if (status >= 500) {
      const message = this.extractLogMessage(exception);
      const stack =
        exception instanceof Error ? exception.stack : 'No stack available';

      this.logger.error(
        `Exception at ${request.method} ${request.url}: ${message}`,
      );
      console.error(
        `Exception at ${request.method} ${request.url}:`,
        exception,
      );

      const discordMessage = `
Internal Server Error

Time: ${timestamp}
Service: ${service}
Request: ${request.method} ${request.url}
Status Code: ${status}
Error Message: ${message}

Stack Trace:
\`\`\`
${stack}
\`\`\`
      `.trim();

      discordAlert(discordMessage).catch((err) => {
        const alertError = err instanceof Error ? err.message : String(err);
        this.logger.error(`Discord alert failed: ${alertError}`);
      });
    }

    return response.status(status).json(this.buildErrorBody(exception, status));
  }

  private buildErrorBody(exception: unknown, status: number) {
    if (exception instanceof HttpException) {
      const raw = exception.getResponse();
      if (
        status >= 500 &&
        !(exception instanceof ServiceUnavailableException)
      ) {
        return {
          error: {
            code: 'INTERNAL_ERROR',
            message: 'An unexpected error occurred.',
          },
        };
      }
      const body =
        typeof raw === 'object' && raw !== null
          ? (raw as Record<string, unknown>)
          : {};
      const rawMessage = body.message;
      const message =
        typeof rawMessage === 'string'
          ? rawMessage
          : Array.isArray(rawMessage)
            ? 'Request validation failed.'
            : typeof raw === 'string'
              ? raw
              : exception.message;
      const code =
        typeof body.code === 'string' ? body.code : this.statusToCode(status);
      const details = Array.isArray(rawMessage)
        ? rawMessage.map((item) => ({ message: String(item) }))
        : body.details;

      return {
        error: {
          code,
          message,
          ...(details ? { details } : {}),
        },
      };
    }

    return {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      },
    };
  }

  private extractLogMessage(exception: unknown): string {
    if (exception instanceof HttpException) {
      const raw = exception.getResponse();
      if (typeof raw === 'object' && raw !== null && 'message' in raw) {
        const { message } = raw;
        return Array.isArray(message) ? message.join(', ') : String(message);
      }
      return exception.message;
    }
    if (exception instanceof Error) return exception.message;
    return 'Internal server error';
  }

  private statusToCode(status: number): string {
    const map: Record<number, string> = {
      400: 'VALIDATION_ERROR',
      401: 'UNAUTHENTICATED',
      403: 'FORBIDDEN',
      404: 'NOT_FOUND',
      409: 'INVALID_STATE',
      410: 'INVITE_INVALID',
      422: 'VALIDATION_ERROR',
      429: 'RATE_LIMITED',
      503: 'SERVICE_UNAVAILABLE',
    };
    return map[status] ?? 'INTERNAL_ERROR';
  }
}
