import type { ActorContext } from '../../platform/actor/actor.types';
import { ISSUE_ENTITY } from '../../uploads/entity-types';
import { systemCommandKit } from '../system-command.testkit';
import { CompletionService } from './completion.service';
import { IssuesService } from './issues.service';

const NOW = new Date('2026-10-26T10:00:00.000Z');
const customerActor = {
  userId: 'customer-1',
  kind: 'customer',
  platformRoles: ['customer'],
  accountActive: true,
} as unknown as ActorContext;

describe('issue attachments (D-34)', () => {
  it('completion.respond attaches [{ id }] to the issue it raises', async () => {
    const tx = {
      serviceRequest: {
        update: jest.fn().mockResolvedValue({ issueCycles: 1 }),
      },
      issue: { create: jest.fn().mockResolvedValue({ id: 'i1' }) },
    };
    const kit = systemCommandKit({
      tx,
      now: NOW,
      snap: {
        status: 'completion_pending',
        ownerId: 'customer-1',
        openIssues: [],
      } as never,
    });
    const uploads = { attach: jest.fn().mockResolvedValue([]) };
    const service = new CompletionService(
      { resolve: jest.fn().mockResolvedValue(customerActor) } as never,
      kit.runner,
      {} as never,
      uploads as never,
    );

    await service.respond(
      { id: 'customer-1' } as never,
      'XPR-00042',
      {
        acknowledge: false,
        note: 'The tiles are cracked.',
        attachments: [{ id: 'f1' }, { id: 'f2' }],
      },
      undefined,
      '/url',
    );

    expect(uploads.attach).toHaveBeenCalledWith(
      tx,
      ['f1', 'f2'],
      'customer-1',
      'progress_evidence',
      ISSUE_ENTITY,
      'i1',
    );
  });

  it('issue.raise attaches [{ id }] to the new issue', async () => {
    const tx = {
      serviceRequest: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ issueCycles: 0 }),
        update: jest.fn(),
      },
      issue: { create: jest.fn().mockResolvedValue({ id: 'i2' }) },
    };
    const kit = systemCommandKit({
      tx,
      now: NOW,
      snap: {
        status: 'acknowledged',
        ownerId: 'customer-1',
        defectsWindowEndsAt: new Date(NOW.getTime() + 86_400_000),
        openIssues: [],
      } as never,
    });
    const uploads = { attach: jest.fn().mockResolvedValue([]) };
    const service = new IssuesService(
      { resolve: jest.fn().mockResolvedValue(customerActor) } as never,
      kit.runner,
      uploads as never,
      { holdForIssue: jest.fn() } as never,
      {} as never,
    );

    await service.raise(
      { id: 'customer-1' } as never,
      'XPR-00042',
      { note: 'The leak is back.', attachments: [{ id: 'f3' }] },
      undefined,
      '/url',
    );

    expect(uploads.attach).toHaveBeenCalledWith(
      tx,
      ['f3'],
      'customer-1',
      'progress_evidence',
      ISSUE_ENTITY,
      'i2',
    );
  });
});
