import { StaffRole } from '@prisma/client';
import { NotificationDispatcher } from './notification-dispatcher';
import { StaffRoutingService } from './staff-routing.service';

type Member = { userId: string; roles: StaffRole[] };
type MemberQuery = {
  where: { userId?: string; roles?: { some: { role: { in: StaffRole[] } } } };
};

const CUSTOMER_ID = 'customer-1';
const REQUEST_ID = 'request-1';
const gatedEvent = 'assignment.accepted'; // staff:gated on dispatch.manage

function setup(members: Member[]) {
  const prisma = {
    staffMember: {
      findMany: jest.fn(({ where }: MemberQuery) =>
        Promise.resolve(
          members
            .filter(
              (member) =>
                (!where.userId || member.userId === where.userId) &&
                (!where.roles ||
                  member.roles.some((role) =>
                    where.roles!.some.role.in.includes(role),
                  )),
            )
            .map((member) => ({
              userId: member.userId,
              roles: member.roles.map((role) => ({ role })),
            })),
        ),
      ),
    },
  };
  const inbox = {
    createMany: jest.fn((_tx: unknown, _rows: Array<{ recipientId: string }>) =>
      Promise.resolve(),
    ),
  };
  const outbox = { add: jest.fn().mockResolvedValue(undefined) };
  const dispatcher = new NotificationDispatcher(
    inbox as never,
    new StaffRoutingService(prisma as never),
    outbox as never,
  );
  const alert = async (
    event: string,
    params: Record<string, unknown>,
    actorId: string | null = null,
  ) => {
    inbox.createMany.mockClear();
    await dispatcher.dispatchAlert({} as never, event, params, actorId);
    const rows = inbox.createMany.mock.calls[0]?.[1] ?? [];
    return rows as Array<{
      recipientId: string;
      requestId: string | null;
      mandatory?: boolean;
    }>;
  };
  const send = async (
    event: string,
    staffOwnerId: string | null,
    params: Record<string, unknown> = { requestCode: 'XPR-00001' },
  ) => {
    inbox.createMany.mockClear();
    await dispatcher.dispatch({} as never, event, params, {
      requestId: REQUEST_ID,
      ownerId: CUSTOMER_ID,
      staffOwnerId,
      actorId: null,
    });
    const rows = inbox.createMany.mock.calls[0]?.[1] ?? [];
    return rows.map((row) => row.recipientId).sort();
  };
  return { send, alert };
}

const roster: Member[] = [
  { userId: 'owner-ops', roles: [StaffRole.operations] },
  { userId: 'owner-relations', roles: [StaffRole.client_relations] },
  { userId: 'ops-1', roles: [StaffRole.operations] },
  { userId: 'ops-2', roles: [StaffRole.operations] },
  { userId: 'pricing-1', roles: [StaffRole.pricing] },
];

describe('NotificationDispatcher staff routing (02 §6.8)', () => {
  it('sends a gated event to the owner alone when the owner holds the permission', async () => {
    const { send } = setup(roster);
    expect(await send(gatedEvent, 'owner-ops')).toEqual(['owner-ops']);
  });

  it('informs an owner who lacks the permission, and every holder', async () => {
    const { send } = setup(roster);
    expect(await send(gatedEvent, 'owner-relations')).toEqual(
      ['owner-ops', 'ops-1', 'ops-2', 'owner-relations'].sort(),
    );
  });

  it('sends a gated event to every holder when the request is unclaimed', async () => {
    const { send } = setup(roster);
    expect(await send(gatedEvent, null)).toEqual(
      ['owner-ops', 'ops-1', 'ops-2'].sort(),
    );
  });

  it('never treats the customer as the staff owner', async () => {
    const { send } = setup([
      ...roster,
      { userId: CUSTOMER_ID, roles: [StaffRole.operations] },
    ]);
    expect(await send(gatedEvent, 'owner-ops')).toEqual(['owner-ops']);
  });

  it('sends an informational event to the owner alone', async () => {
    const { send } = setup(roster);
    expect(await send('request.needs_owner', 'owner-relations')).toEqual([
      'owner-relations',
    ]);
  });

  it('keeps the customer id for the customer audience', async () => {
    const { send } = setup(roster);
    expect(await send('request.received', 'owner-ops')).toEqual([CUSTOMER_ID]);
  });
});

describe('NotificationDispatcher money alerts (05 §7, §8)', () => {
  const finance: Member[] = [
    { userId: 'finance-1', roles: [StaffRole.finance] },
    { userId: 'finance-2', roles: [StaffRole.finance] },
    { userId: 'admin-1', roles: [StaffRole.super_admin] },
    { userId: 'ops-1', roles: [StaffRole.operations] },
  ];

  it('sends a quarantine alert to every payment.record holder and every super admin, with no request', async () => {
    const { alert } = setup(finance);
    const rows = await alert('payment.quarantined', {
      requestCode: 'XPR-00042',
      reference: 'xpro_abc',
      reason: 'The transaction amount differs.',
    });
    expect(rows.map((row) => row.recipientId).sort()).toEqual([
      'admin-1',
      'finance-1',
      'finance-2',
    ]);
    expect(rows.every((row) => row.requestId === null)).toBe(true);
    expect(rows.every((row) => row.mandatory === true)).toBe(true);
  });

  it('does not alert the actor', async () => {
    const { alert } = setup(finance);
    const rows = await alert(
      'gateway.event_dead_lettered',
      { event: 'charge.success', reference: 'xpro_abc' },
      'finance-1',
    );
    expect(rows.map((row) => row.recipientId).sort()).toEqual([
      'admin-1',
      'finance-2',
    ]);
  });

  it('refuses events that are not request-free alerts', async () => {
    const { alert } = setup(finance);
    await expect(alert('request.received', {})).rejects.toThrow(
      'request.received is not a request-free alert.',
    );
  });

  it('routes a request-bound quarantine alert to the same holders', async () => {
    const { send } = setup(finance);
    expect(
      await send('payment.quarantined', null, {
        requestCode: 'XPR-00042',
        reference: 'xpro_abc',
        reason: 'x',
      }),
    ).toEqual(['admin-1', 'finance-1', 'finance-2']);
  });

  it('sends Paid — schedule it by schedule.manage routing', async () => {
    const { send } = setup([
      { userId: 'ops-1', roles: [StaffRole.operations] },
      { userId: 'ops-2', roles: [StaffRole.operations] },
      { userId: 'finance-1', roles: [StaffRole.finance] },
    ]);
    expect(await send('payment.settled_staff', 'ops-1')).toEqual(['ops-1']);
    expect(await send('payment.settled_staff', null)).toEqual([
      'ops-1',
      'ops-2',
    ]);
  });
});
