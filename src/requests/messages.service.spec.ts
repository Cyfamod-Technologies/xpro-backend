import type { ActorContext } from '../platform/actor/actor.types';
import { AppError } from '../platform/errors/app-error';
import {
  canReadChannel,
  canWriteChannel,
  messageRole,
  MessagesService,
  renderAuthor,
} from './messages.service';

const assignment = {
  providerId: 'provider-1',
  providerUserId: 'provider-user-1',
  status: 'accepted',
};
const customer: ActorContext = {
  userId: 'customer-1',
  kind: 'customer',
  displayName: 'Casey Customer',
  platformRoles: ['customer'],
  accountActive: true,
};
const provider: ActorContext = {
  userId: 'provider-user-1',
  kind: 'provider',
  displayName: 'Pat Provider',
  platformRoles: ['provider'],
  accountActive: true,
};
const formerProvider: ActorContext = { ...provider, userId: 'former-provider' };
const staff: ActorContext = {
  userId: 'staff-1',
  kind: 'staff',
  displayName: 'Sam Staff',
  platformRoles: ['staff'],
  accountActive: true,
  staff: {
    status: 'active',
    roles: ['client_relations'],
    permissions: new Set(['message.customer', 'message.internal']),
    canOwn: true,
    isSuperAdmin: false,
    permVersion: 1,
  },
};

describe('request message channel access', () => {
  it('keeps customers in their own channel and rejects provider channels with the documented message', () => {
    expect(
      canReadChannel(customer, 'customer-1', 'customer', null, assignment),
    ).toBe(true);
    expect(
      canWriteChannel(customer, 'customer-1', 'customer', null, assignment),
    ).toBe(true);
    expect(
      canReadChannel(
        customer,
        'customer-1',
        'provider',
        'provider-1',
        assignment,
      ),
    ).toBe(false);
    expect(
      canWriteChannel(customer, 'customer-1', 'internal', null, assignment),
    ).toBe(false);
  });

  it('allows only the current offered or assigned provider thread', () => {
    expect(
      canReadChannel(
        provider,
        'customer-1',
        'provider',
        'provider-1',
        assignment,
      ),
    ).toBe(true);
    expect(
      canWriteChannel(
        provider,
        'customer-1',
        'provider',
        'provider-1',
        assignment,
      ),
    ).toBe(true);
    expect(
      canReadChannel(
        formerProvider,
        'customer-1',
        'provider',
        'provider-1',
        assignment,
      ),
    ).toBe(false);
    expect(
      canWriteChannel(
        formerProvider,
        'customer-1',
        'provider',
        'provider-1',
        assignment,
      ),
    ).toBe(false);
    expect(
      canReadChannel(provider, 'customer-1', 'customer', null, assignment),
    ).toBe(false);
  });

  it('enforces the matching staff permission for each channel', () => {
    expect(
      canReadChannel(staff, 'customer-1', 'customer', null, assignment),
    ).toBe(true);
    expect(
      canReadChannel(staff, 'customer-1', 'internal', null, assignment),
    ).toBe(true);
    expect(
      canReadChannel(staff, 'customer-1', 'provider', 'provider-1', assignment),
    ).toBe(false);
    expect(
      canWriteChannel(
        staff,
        'customer-1',
        'provider',
        'provider-1',
        assignment,
      ),
    ).toBe(false);
  });
});

describe('request message author labels', () => {
  const staffNames = new Map([['staff-1', 'Sam Staff']]);

  it('masks staff names from customers and providers while keeping staff identities in staff views', () => {
    expect(renderAuthor('staff', 'staff-1', customer, staffNames)).toBe(
      'XPro Team',
    );
    expect(renderAuthor('staff', 'staff-1', provider, staffNames)).toBe(
      'XPro Dispatch',
    );
    expect(renderAuthor('staff', 'staff-1', staff, staffNames)).toBe(
      'Sam Staff',
    );
  });
});

describe('request message roles for an account with several platform roles (A-15)', () => {
  const dualRole: ActorContext = {
    ...provider,
    userId: 'customer-1',
    platformRoles: ['provider', 'customer'],
  };

  it('treats the owner as the owner first, whatever the actor kind', () => {
    expect(messageRole(dualRole, 'customer-1', [assignment])).toBe('owner');
    expect(canReadChannel(dualRole, 'customer-1', 'customer', null, null)).toBe(
      true,
    );
    expect(
      canWriteChannel(dualRole, 'customer-1', 'customer', null, null),
    ).toBe(true);
    expect(
      canWriteChannel(dualRole, 'customer-1', 'provider', null, assignment),
    ).toBe(false);
  });

  it('falls back to the provider assignment, then to active staff', () => {
    expect(messageRole(provider, 'customer-1', [assignment])).toBe('provider');
    expect(messageRole(formerProvider, 'customer-1', [assignment])).toBeNull();
    expect(messageRole(staff, 'customer-1', [assignment])).toBe('staff');
    expect(messageRole(customer, 'someone-else', [assignment])).toBeNull();
  });
});

describe('MessagesService.send', () => {
  const ownerActor: ActorContext = {
    ...customer,
    kind: 'provider',
    platformRoles: ['provider', 'customer'],
  };

  function build(uploads: Array<{ id: string; size: number }>) {
    const tx = {
      serviceRequest: {
        findUnique: jest.fn().mockResolvedValue({
          ownerId: 'customer-1',
          intakeState: 'pending',
          number: 42,
          assignments: [],
        }),
        update: jest.fn(),
      },
      requestMessage: {
        create: jest.fn().mockResolvedValue({ id: 'message-1' }),
      },
      upload: {
        findMany: jest.fn().mockResolvedValue(uploads),
        updateMany: jest.fn().mockResolvedValue({ count: uploads.length }),
      },
    };
    const context = {
      tx,
      snap: { id: 'request-1', number: 'XPR-00042' },
      now: new Date('2026-10-25T12:00:00.000Z'),
      audit: jest.fn(),
      notify: jest.fn(),
      timers: { stop: jest.fn() },
      approvals: { close: jest.fn() },
    };
    const runner = {
      run: jest.fn(
        async (
          _options: unknown,
          command: (value: unknown) => Promise<unknown>,
        ) => {
          await command(context);
          return { status: 201, body: {}, etag: 'W/"2"' };
        },
      ),
    };
    const service = new MessagesService(
      {} as never,
      { resolve: jest.fn().mockResolvedValue(ownerActor) } as never,
      runner as never,
      { hashRequest: jest.fn().mockReturnValue('hash') } as never,
    );
    return { service, tx, runner };
  }
  const user = { id: 'customer-1' } as never;

  it('attaches a ready upload however long ago it was completed (A-24)', async () => {
    const { service, tx } = build([{ id: 'upload-1', size: 1024 }]);

    await service.send(
      user,
      'XPR-00042',
      {
        channel: 'customer',
        text: 'Photos attached',
        attachments: [{ id: 'upload-1' }],
      },
      '/requests/XPR-00042/messages',
    );

    const [lookup] = tx.upload.findMany.mock.calls[0] as [{ where: object }];
    expect(lookup.where).not.toHaveProperty('expiresAt');
    const [update] = tx.upload.updateMany.mock.calls[0] as [{ where: object }];
    expect(update.where).not.toHaveProperty('expiresAt');
  });

  it('answers file problems with 422 VALIDATION_ERROR, not 409 (A-18)', async () => {
    const missing = build([]);
    await expect(
      missing.service.send(
        user,
        'XPR-00042',
        { channel: 'customer', attachments: [{ id: 'upload-1' }] },
        '/requests/XPR-00042/messages',
      ),
    ).rejects.toMatchObject({
      status: 422,
      response: {
        code: 'VALIDATION_ERROR',
        message:
          "One of your files didn't finish uploading. Remove it and try again.",
      },
    });

    const tooBig = build([{ id: 'upload-1', size: 26 * 1024 * 1024 }]);
    await expect(
      tooBig.service.send(
        user,
        'XPR-00042',
        { channel: 'customer', attachments: [{ id: 'upload-1' }] },
        '/requests/XPR-00042/messages',
      ),
    ).rejects.toMatchObject({ status: 422 });

    const duplicate = build([{ id: 'upload-1', size: 1 }]);
    const error: unknown = await duplicate.service
      .send(
        user,
        'XPR-00042',
        {
          channel: 'customer',
          attachments: [{ id: 'upload-1' }, { id: 'upload-1' }],
        },
        '/requests/XPR-00042/messages',
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 422 });
  });

  it('lets the owner of the request answer through the customer channel even when the account is a provider', async () => {
    const { service, runner } = build([]);

    await service.send(
      user,
      'XPR-00042',
      { channel: 'customer', text: 'Here is the answer' },
      '/requests/XPR-00042/messages',
    );

    expect(runner.run).toHaveBeenCalledTimes(1);
  });
});
