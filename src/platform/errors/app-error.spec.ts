import { BadRequestException } from '@nestjs/common';
import { ThrottlerException } from '@nestjs/throttler';
import { ExceptionLoggingFilter } from '../../common/filters/exception-logging.filter';
import { AppError } from './app-error';

function render(exception: unknown) {
  const json = jest.fn<void, [{ error: Record<string, unknown> }]>();
  const status = jest.fn<{ json: typeof json }, [number]>(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ headersSent: false, status }),
      getRequest: () => ({ method: 'POST', url: '/x' }),
    }),
  };
  new ExceptionLoggingFilter().catch(exception, host as never);
  return {
    status: status.mock.calls[0][0],
    body: json.mock.calls[0][0],
  };
}

describe('error envelope', () => {
  it('renders an AppError with its code, message and details', () => {
    const { status, body } = render(
      new AppError(409, 'VERSION_CONFLICT', 'This request has changed.', {
        current: { version: 4 },
      }),
    );
    expect(status).toBe(409);
    expect(body).toEqual({
      error: {
        code: 'VERSION_CONFLICT',
        message: 'This request has changed.',
        details: { current: { version: 4 } },
      },
    });
  });

  it('omits details when none are given', () => {
    const { body } = render(new AppError(404, 'NOT_FOUND', 'Not found.'));
    expect(body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Not found.' },
    });
  });

  it('keeps DTO shape errors at 400 with code VALIDATION_ERROR', () => {
    const { status, body } = render(
      new BadRequestException(['name must be a string']),
    );
    expect(status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('maps the throttler to 429 RATE_LIMITED', () => {
    const { status, body } = render(new ThrottlerException());
    expect(status).toBe(429);
    expect(body.error.code).toBe('RATE_LIMITED');
  });
});
