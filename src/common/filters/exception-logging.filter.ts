import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
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

    return response
      .status(status)
      .json(this.buildErrorBody(exception, status, request));
  }

  private buildErrorBody(exception: unknown, status: number, request: Request) {
    const meta = { path: request.url, method: request.method };

    if (exception instanceof HttpException) {
      const raw = exception.getResponse();

      if (typeof raw === 'string') {
        return {
          statusCode: status,
          message: raw,
          error: this.statusToError(status),
          data: null,
          ...meta,
        };
      }

      if (typeof raw === 'object' && raw !== null) {
        const { message, error } = raw as Record<string, unknown>;
        const errorLabel =
          typeof error === 'string' ? error : this.statusToError(status);

        if (Array.isArray(message)) {
          return {
            statusCode: status,
            message: 'Validation failed',
            error: errorLabel,
            errors: message,
            data: null,
            ...meta,
          };
        }

        return {
          statusCode: status,
          message: typeof message === 'string' ? message : exception.message,
          error: errorLabel,
          data: null,
          ...meta,
        };
      }
    }

    const message =
      exception instanceof Error ? exception.message : 'Internal server error';
    return {
      statusCode: 500,
      message: `Internal server error: ${message}`,
      error: 'Internal Server Error',
      data: null,
      ...meta,
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

  private statusToError(status: number): string {
    const map: Record<number, string> = {
      400: 'Bad Request',
      401: 'Unauthorized',
      403: 'Forbidden',
      404: 'Not Found',
      405: 'Method Not Allowed',
      408: 'Request Timeout',
      409: 'Conflict',
      410: 'Gone',
      422: 'Unprocessable Entity',
      429: 'Too Many Requests',
      500: 'Internal Server Error',
      501: 'Not Implemented',
      502: 'Bad Gateway',
      503: 'Service Unavailable',
    };
    return map[status] ?? 'Error';
  }
}
