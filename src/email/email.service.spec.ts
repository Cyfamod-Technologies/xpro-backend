import { ConfigService } from '@nestjs/config';
import {
  createTransport,
  type SendMailOptions,
  type Transporter,
} from 'nodemailer';
import { EmailRendererService } from './email-renderer.service';
import { EmailService } from './email.service';

jest.mock('nodemailer', () => ({ createTransport: jest.fn() }));

describe('EmailService', () => {
  const createTransportMock = jest.mocked(createTransport);
  const sendMailMock = jest.fn<
    Promise<{ messageId: string }>,
    [SendMailOptions]
  >();
  const email = {
    notificationId: 'notification-1',
    recipientEmail: 'ada@example.com',
    templateKey: 'welcome' as const,
    payload: { firstName: 'Ada' },
  };

  function createService(overrides: Record<string, string> = {}) {
    const config = new ConfigService({
      SMTP_HOST: 'smtp.hostinger.com',
      SMTP_PORT: '465',
      SMTP_USER: 'noreply@xpro.example',
      SMTP_PASSWORD: 'mailbox-password',
      EMAIL_FROM: 'noreply@xpro.example',
      EMAIL_FROM_NAME: 'Xpro',
      EMAIL_REPLY_TO: 'support@xpro.example',
      ...overrides,
    });
    const renderer = new EmailRendererService(config);
    return new EmailService(config, renderer);
  }

  beforeEach(() => {
    jest.clearAllMocks();
    sendMailMock.mockResolvedValue({ messageId: '<message-1@xpro.example>' });
    createTransportMock.mockReturnValue({
      sendMail: sendMailMock,
    } as unknown as Transporter);
  });

  it('uses implicit TLS on port 465 and sends rendered content with tracing', async () => {
    const service = createService();

    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.hostinger.com',
        port: 465,
        secure: true,
        requireTLS: false,
        auth: {
          user: 'noreply@xpro.example',
          pass: 'mailbox-password',
        },
      }),
    );

    await expect(service.sendQueuedEmail(email)).resolves.toEqual({
      provider: 'smtp',
      id: '<message-1@xpro.example>',
      response: { messageId: '<message-1@xpro.example>' },
    });
    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const message = sendMailMock.mock.calls[0][0];
    expect(message.from).toEqual({
      address: 'noreply@xpro.example',
      name: 'Xpro',
    });
    expect(message.to).toBe('ada@example.com');
    expect(message.replyTo).toEqual({
      address: 'support@xpro.example',
      name: 'support',
    });
    expect(message.headers).toEqual({ 'X-Notification-Id': 'notification-1' });
    expect(message.subject).toBeTruthy();
    expect(message.html).toContain('<!doctype html>');
    expect(message.text).toBeTruthy();
  });

  it('requires STARTTLS on port 587', () => {
    createService({ SMTP_PORT: '587' });

    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({ port: 587, secure: false, requireTLS: true }),
    );
  });

  it('fails a send when SMTP is incomplete', async () => {
    const service = createService({ SMTP_PASSWORD: '' });

    expect(createTransportMock).not.toHaveBeenCalled();
    await expect(service.sendQueuedEmail(email)).rejects.toThrow(
      'SMTP is not configured',
    );
  });

  it('rethrows SMTP errors for the queue processor to handle', async () => {
    const service = createService();
    const error = new Error('SMTP rejected message');
    sendMailMock.mockRejectedValue(error);

    await expect(service.sendQueuedEmail(email)).rejects.toBe(error);
  });
});
