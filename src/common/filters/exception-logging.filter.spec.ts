import {
  ArgumentsHost,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { discordAlert } from '../utils/discord-alert';
import { ExceptionLoggingFilter } from './exception-logging.filter';

jest.mock('../utils/discord-alert', () => ({
  discordAlert: jest.fn().mockResolvedValue(undefined),
}));

function run(exception: unknown) {
  const json = jest.fn<void, [unknown]>();
  const response = {
    headersSent: false,
    status: jest.fn().mockReturnValue({ json }),
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ method: 'GET', url: '/files/1' }),
    }),
  } as unknown as ArgumentsHost;
  new ExceptionLoggingFilter().catch(exception, host);
  return { status: response.status, body: json.mock.calls[0]?.[0] };
}

describe('ExceptionLoggingFilter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('passes the message of a 503 through with SERVICE_UNAVAILABLE', () => {
    const { status, body } = run(
      new ServiceUnavailableException('File uploads are not configured.'),
    );
    expect(status).toHaveBeenCalledWith(503);
    expect(body).toEqual({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'File uploads are not configured.',
      },
    });
  });

  it('keeps a code supplied on a 503', () => {
    const { body } = run(
      new ServiceUnavailableException({
        code: 'PAYSTACK_DOWN',
        message: 'Try later.',
      }),
    );
    expect(body).toEqual({
      error: { code: 'PAYSTACK_DOWN', message: 'Try later.' },
    });
  });

  it('still alerts Discord for a 503', () => {
    run(new ServiceUnavailableException('File uploads are not configured.'));
    expect(discordAlert).toHaveBeenCalledTimes(1);
  });

  it('keeps the generic message for other 5xx errors', () => {
    const { status, body } = run(
      new InternalServerErrorException('database password leaked'),
    );
    expect(status).toHaveBeenCalledWith(500);
    expect(body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      },
    });
    expect(discordAlert).toHaveBeenCalledTimes(1);
  });

  it('keeps the generic message for non-HTTP errors', () => {
    const { status, body } = run(new Error('boom'));
    expect(status).toHaveBeenCalledWith(500);
    expect(body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected error occurred.',
      },
    });
  });
});
