import type { Upload } from '@prisma/client';
import type { RequestUser } from '../common/types/request-user';
import type { ActorContext } from '../platform/actor/actor.types';
import {
  ISSUE_ENTITY,
  MESSAGE_ENTITY,
  NOSHOW_ENTITY,
  PROGRESS_UPDATE_ENTITY,
  REQUEST_ENTITY,
} from '../uploads/entity-types';
import type { UploadAccessResolver } from '../uploads/file-access.service';
import { RequestFileAccess } from './request-file-access';

type Perm = 'progress.review' | 'issue.resolve' | 'dispatch.manage' | 'other';

const user = (id: string) => ({ id }) as unknown as RequestUser;
const upload = (entityId: string | null = 'entity-1') =>
  ({ id: 'upload-1', entityId }) as unknown as Upload;

const customer: ActorContext = {
  userId: 'customer-1',
  kind: 'customer',
  displayName: 'Customer',
  platformRoles: ['customer'],
  accountActive: true,
};
const provider = (id: string): ActorContext => ({
  userId: id,
  kind: 'provider',
  displayName: 'Provider',
  platformRoles: ['provider'],
  accountActive: true,
});
const staff = (
  id: string,
  permissions: Perm[],
  status: 'active' | 'suspended' = 'active',
): ActorContext =>
  ({
    userId: id,
    kind: 'staff',
    displayName: 'Staff',
    platformRoles: ['staff'],
    accountActive: true,
    staff: {
      status,
      roles: [],
      permissions: new Set(status === 'active' ? permissions : []),
      canOwn: false,
      isSuperAdmin: false,
      permVersion: 1,
    },
  }) as unknown as ActorContext;

function setup(actors: Record<string, ActorContext>) {
  const resolvers = new Map<string, UploadAccessResolver>();
  const prisma = {
    serviceRequest: { findUnique: jest.fn() },
    progressUpdate: { findUnique: jest.fn() },
    assignment: { findUnique: jest.fn() },
    issue: { findUnique: jest.fn() },
    noShow: { findUnique: jest.fn() },
    requestMessage: { findUnique: jest.fn() },
  };
  const access = {
    register: (type: string, resolver: UploadAccessResolver) =>
      resolvers.set(type, resolver),
  };
  const service = new RequestFileAccess(
    access as never,
    prisma as never,
    { resolve: (id: string) => Promise.resolve(actors[id]) } as never,
  );
  service.onModuleInit();
  const can = (type: string, userId: string, entityId?: string | null) =>
    resolvers.get(type)!(user(userId), upload(entityId));
  return { prisma, resolvers, can };
}

describe('RequestFileAccess registration', () => {
  it('registers every request-related entity type', () => {
    const { resolvers } = setup({});
    expect([...resolvers.keys()].sort()).toEqual(
      [
        REQUEST_ENTITY,
        MESSAGE_ENTITY,
        PROGRESS_UPDATE_ENTITY,
        ISSUE_ENTITY,
        NOSHOW_ENTITY,
      ].sort(),
    );
    expect(REQUEST_ENTITY).toBe('service_request');
  });
});

describe('request resolver', () => {
  const actors = {
    'customer-1': customer,
    stranger: { ...customer, userId: 'stranger' },
    'staff-1': staff('staff-1', ['other']),
    'staff-off': staff('staff-off', [], 'suspended'),
    'prov-1': provider('prov-1'),
    'prov-2': provider('prov-2'),
  };
  const request = (overrides: Record<string, unknown> = {}) => ({
    ownerId: 'customer-1',
    assignments: [{ id: 'a-1', providerUserId: 'prov-1', status: 'accepted' }],
    attachments: [{ sharedWithProvider: false }],
    schedules: [],
    ...overrides,
  });

  it('allows the owner and active staff, denies strangers and inactive staff', async () => {
    const { prisma, can } = setup(actors);
    prisma.serviceRequest.findUnique.mockResolvedValue(request());
    await expect(can(REQUEST_ENTITY, 'customer-1')).resolves.toBe(true);
    await expect(can(REQUEST_ENTITY, 'staff-1')).resolves.toBe(true);
    await expect(can(REQUEST_ENTITY, 'staff-off')).resolves.toBe(false);
    await expect(can(REQUEST_ENTITY, 'stranger')).resolves.toBe(false);
    await expect(can(REQUEST_ENTITY, 'prov-2')).resolves.toBe(false);
  });

  it('denies when the upload has no entity or the request is missing', async () => {
    const { prisma, can } = setup(actors);
    await expect(can(REQUEST_ENTITY, 'customer-1', null)).resolves.toBe(false);
    prisma.serviceRequest.findUnique.mockResolvedValue(null);
    await expect(can(REQUEST_ENTITY, 'customer-1')).resolves.toBe(false);
  });

  it('keeps a file hidden from the provider until it is shared or the schedule is locked', async () => {
    const { prisma, can } = setup(actors);
    prisma.serviceRequest.findUnique.mockResolvedValue(request());
    await expect(can(REQUEST_ENTITY, 'prov-1')).resolves.toBe(false);

    prisma.serviceRequest.findUnique.mockResolvedValue(
      request({ attachments: [{ sharedWithProvider: true }] }),
    );
    await expect(can(REQUEST_ENTITY, 'prov-1')).resolves.toBe(true);

    prisma.serviceRequest.findUnique.mockResolvedValue(
      request({ schedules: [{ assignmentId: 'a-1' }] }),
    );
    await expect(can(REQUEST_ENTITY, 'prov-1')).resolves.toBe(true);
  });

  it('denies a provider whose assignment is not accessible', async () => {
    const { prisma, can } = setup(actors);
    prisma.serviceRequest.findUnique.mockResolvedValue(
      request({
        assignments: [
          { id: 'a-1', providerUserId: 'prov-1', status: 'withdrawn' },
        ],
        attachments: [{ sharedWithProvider: true }],
      }),
    );
    await expect(can(REQUEST_ENTITY, 'prov-1')).resolves.toBe(false);
  });
});

describe('progress_update resolver', () => {
  const actors = {
    'customer-1': customer,
    stranger: { ...customer, userId: 'stranger' },
    'prov-1': provider('prov-1'),
    'prov-2': provider('prov-2'),
    reviewer: staff('reviewer', ['progress.review']),
    resolver: staff('resolver', ['issue.resolve']),
    dispatcher: staff('dispatcher', ['dispatch.manage']),
    'reviewer-off': staff('reviewer-off', ['progress.review'], 'suspended'),
  };
  const update = (state: string) => ({
    authorId: 'prov-1',
    assignmentId: 'a-1',
    state,
    request: { ownerId: 'customer-1' },
  });

  it('allows the author while the assignment is accessible', async () => {
    const { prisma, can } = setup(actors);
    prisma.progressUpdate.findUnique.mockResolvedValue(update('pending'));
    for (const status of [
      'offered',
      'pending_approval',
      'accepted',
      'completed',
    ]) {
      prisma.assignment.findUnique.mockResolvedValue({ status });
      await expect(can(PROGRESS_UPDATE_ENTITY, 'prov-1')).resolves.toBe(true);
    }
  });

  it('denies the author once the assignment is withdrawn or replaced', async () => {
    const { prisma, can } = setup(actors);
    prisma.progressUpdate.findUnique.mockResolvedValue(update('approved'));
    for (const status of ['withdrawn', 'declined', 'replaced', 'expired']) {
      prisma.assignment.findUnique.mockResolvedValue({ status });
      await expect(can(PROGRESS_UPDATE_ENTITY, 'prov-1')).resolves.toBe(false);
    }
  });

  it('denies other providers and strangers', async () => {
    const { prisma, can } = setup(actors);
    prisma.progressUpdate.findUnique.mockResolvedValue(update('approved'));
    prisma.assignment.findUnique.mockResolvedValue({ status: 'accepted' });
    await expect(can(PROGRESS_UPDATE_ENTITY, 'prov-2')).resolves.toBe(false);
    await expect(can(PROGRESS_UPDATE_ENTITY, 'stranger')).resolves.toBe(false);
  });

  it('allows staff with progress.review or issue.resolve only', async () => {
    const { prisma, can } = setup(actors);
    prisma.progressUpdate.findUnique.mockResolvedValue(update('pending'));
    await expect(can(PROGRESS_UPDATE_ENTITY, 'reviewer')).resolves.toBe(true);
    await expect(can(PROGRESS_UPDATE_ENTITY, 'resolver')).resolves.toBe(true);
    await expect(can(PROGRESS_UPDATE_ENTITY, 'dispatcher')).resolves.toBe(
      false,
    );
    await expect(can(PROGRESS_UPDATE_ENTITY, 'reviewer-off')).resolves.toBe(
      false,
    );
  });

  it('lets the owner see evidence only after approval', async () => {
    const { prisma, can } = setup(actors);
    for (const state of ['pending', 'rejected']) {
      prisma.progressUpdate.findUnique.mockResolvedValue(update(state));
      await expect(can(PROGRESS_UPDATE_ENTITY, 'customer-1')).resolves.toBe(
        false,
      );
    }
    prisma.progressUpdate.findUnique.mockResolvedValue(update('approved'));
    await expect(can(PROGRESS_UPDATE_ENTITY, 'customer-1')).resolves.toBe(true);
  });

  it('denies when the update is missing or the upload has no entity', async () => {
    const { prisma, can } = setup(actors);
    prisma.progressUpdate.findUnique.mockResolvedValue(null);
    await expect(can(PROGRESS_UPDATE_ENTITY, 'reviewer')).resolves.toBe(false);
    await expect(can(PROGRESS_UPDATE_ENTITY, 'reviewer', null)).resolves.toBe(
      false,
    );
  });
});

describe('issue resolver', () => {
  const actors = {
    'customer-1': customer,
    stranger: { ...customer, userId: 'stranger' },
    'prov-1': provider('prov-1'),
    'prov-2': provider('prov-2'),
    resolver: staff('resolver', ['issue.resolve']),
    reviewer: staff('reviewer', ['progress.review']),
    dispatcher: staff('dispatcher', ['dispatch.manage']),
  };
  const issue = (status = 'accepted') => ({
    request: {
      ownerId: 'customer-1',
      assignments: [{ providerUserId: 'prov-1', status }],
    },
  });

  it('allows the owner, the current provider and issue staff', async () => {
    const { prisma, can } = setup(actors);
    prisma.issue.findUnique.mockResolvedValue(issue());
    await expect(can(ISSUE_ENTITY, 'customer-1')).resolves.toBe(true);
    await expect(can(ISSUE_ENTITY, 'prov-1')).resolves.toBe(true);
    await expect(can(ISSUE_ENTITY, 'resolver')).resolves.toBe(true);
    await expect(can(ISSUE_ENTITY, 'reviewer')).resolves.toBe(true);
  });

  it('denies strangers, other providers and unrelated staff', async () => {
    const { prisma, can } = setup(actors);
    prisma.issue.findUnique.mockResolvedValue(issue());
    await expect(can(ISSUE_ENTITY, 'stranger')).resolves.toBe(false);
    await expect(can(ISSUE_ENTITY, 'prov-2')).resolves.toBe(false);
    await expect(can(ISSUE_ENTITY, 'dispatcher')).resolves.toBe(false);
  });

  it('denies a provider whose assignment ended', async () => {
    const { prisma, can } = setup(actors);
    prisma.issue.findUnique.mockResolvedValue(issue('withdrawn'));
    await expect(can(ISSUE_ENTITY, 'prov-1')).resolves.toBe(false);
  });

  it('denies when the issue is missing', async () => {
    const { prisma, can } = setup(actors);
    prisma.issue.findUnique.mockResolvedValue(null);
    await expect(can(ISSUE_ENTITY, 'resolver')).resolves.toBe(false);
  });
});

describe('noshow resolver', () => {
  const actors = {
    'customer-1': customer,
    'prov-1': provider('prov-1'),
    dispatcher: staff('dispatcher', ['dispatch.manage']),
    reviewer: staff('reviewer', ['progress.review', 'issue.resolve']),
    'dispatcher-off': staff('dispatcher-off', ['dispatch.manage'], 'suspended'),
  };

  it('allows only active staff holding dispatch.manage', async () => {
    const { prisma, can } = setup(actors);
    prisma.noShow.findUnique.mockResolvedValue({ id: 'entity-1' });
    await expect(can(NOSHOW_ENTITY, 'dispatcher')).resolves.toBe(true);
    await expect(can(NOSHOW_ENTITY, 'reviewer')).resolves.toBe(false);
    await expect(can(NOSHOW_ENTITY, 'dispatcher-off')).resolves.toBe(false);
    await expect(can(NOSHOW_ENTITY, 'customer-1')).resolves.toBe(false);
    await expect(can(NOSHOW_ENTITY, 'prov-1')).resolves.toBe(false);
  });

  it('denies when the record is missing', async () => {
    const { prisma, can } = setup(actors);
    prisma.noShow.findUnique.mockResolvedValue(null);
    await expect(can(NOSHOW_ENTITY, 'dispatcher')).resolves.toBe(false);
  });
});

describe('RequestFileAccess message attachments (A-15)', () => {
  const dualRole: ActorContext = {
    ...provider('customer-1'),
    platformRoles: ['provider', 'customer'],
  };
  const message = (channel: 'customer' | 'provider') => ({
    requestId: 'request-1',
    channel,
    providerId: null,
    request: { ownerId: 'customer-1', assignments: [] },
  });

  it('lets a provider account that owns the request open customer-channel files', async () => {
    const { prisma, can } = setup({ 'customer-1': dualRole });
    prisma.requestMessage.findUnique.mockResolvedValue(message('customer'));
    await expect(can(MESSAGE_ENTITY, 'customer-1', 'message-1')).resolves.toBe(
      true,
    );
  });

  it('still refuses a provider account that does not own the request', async () => {
    const { prisma, can } = setup({
      'provider-9': provider('provider-9'),
    });
    prisma.requestMessage.findUnique.mockResolvedValue(message('customer'));
    await expect(can(MESSAGE_ENTITY, 'provider-9', 'message-1')).resolves.toBe(
      false,
    );
  });
});
