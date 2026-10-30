import { StaffRole } from '@prisma/client';
import { NotificationDispatcher } from './notification-dispatcher';
import { StaffRoutingService } from './staff-routing.service';

type Member = { userId: string; roles: StaffRole[] };
type MemberQuery = {
  where: { userId?: string; roles?: { some: { role: { in: StaffRole[] } } } };
};

const CUSTOMER_ID = 'customer-1';
const REQUEST_ID = 'request-1';
const PROVIDER_USER_ID = 'provider-user-1';
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
  const direct = async (
    event: string,
    params: Record<string, unknown>,
    recipientIds: string[],
    requestId: string | null,
  ) => {
    inbox.createMany.mockClear();
    await dispatcher.dispatchDirect(
      {} as never,
      event,
      params,
      recipientIds,
      requestId,
    );
    return (inbox.createMany.mock.calls[0]?.[1] ?? []) as Array<{
      recipientId: string;
      event: string;
      title: string;
      message: string;
      requestId: string | null;
      link: string | null;
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
  const message = async (
    channel: 'customer' | 'provider' | 'internal',
    staffOwnerId: string | null,
  ) => {
    inbox.createMany.mockClear();
    const tx = {
      serviceRequest: {
        findUnique: jest.fn().mockResolvedValue({
          assignments: [
            {
              providerId: 'provider-1',
              providerUserId: PROVIDER_USER_ID,
              status: 'accepted',
            },
          ],
        }),
      },
    };
    await dispatcher.dispatch(
      tx as never,
      'request.message_update',
      { requestCode: 'XPR-00042', channel, providerId: 'provider-1' },
      {
        requestId: REQUEST_ID,
        ownerId: CUSTOMER_ID,
        staffOwnerId,
        actorId: null,
      },
    );
    const rows = (inbox.createMany.mock.calls[0]?.[1] ?? []) as Array<{
      recipientId: string;
      title: string;
      message: string;
      link: string | null;
    }>;
    return Object.fromEntries(rows.map((row) => [row.recipientId, row]));
  };
  return { send, alert, direct, message };
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

describe('NotificationDispatcher escalations and approval notices (02 §6.10, §6.11)', () => {
  const withAdmins: Member[] = [
    ...roster,
    { userId: 'admin-1', roles: [StaffRole.super_admin] },
    { userId: 'admin-2', roles: [StaffRole.super_admin] },
  ];
  const escalation = {
    requestCode: 'XPR-00042',
    title: 'Roof repair',
    note: 'Customer is unreachable.',
  };

  it('sends an escalation to operations to the owner when they hold request.escalation.resolve', async () => {
    const { send } = setup(withAdmins);
    expect(await send('escalation.raised', 'owner-ops', escalation)).toEqual([
      'owner-ops',
    ]);
  });

  it('sends it to every holder, super admins left out unless nobody else holds it, when unclaimed', async () => {
    const { send } = setup(withAdmins);
    expect(await send('escalation.raised', null, escalation)).toEqual(
      ['owner-ops', 'ops-1', 'ops-2'].sort(),
    );
  });

  it('sends an escalation to super_admin to every active super admin', async () => {
    const { send } = setup(withAdmins);
    expect(
      await send('escalation.raised_super_admin', 'owner-ops', escalation),
    ).toEqual(['admin-1', 'admin-2']);
  });

  it('tells the raiser when it is resolved, with the note', async () => {
    const { send } = setup(withAdmins);
    expect(
      await send('escalation.resolved', null, {
        recipientId: 'ops-1',
        requestCode: 'XPR-00042',
        note: 'Customer reached.',
      }),
    ).toEqual(['ops-1']);
  });

  it('renders the 02 §6.10 title and body', async () => {
    const { direct } = setup(withAdmins);
    const [row] = await direct(
      'escalation.raised',
      escalation,
      ['ops-1'],
      REQUEST_ID,
    );
    expect(row).toMatchObject({
      title: 'Escalation raised',
      message: 'XPR-00042 · Roof repair: Customer is unreachable.',
    });
  });

  it('delivers reminder and overdue notices to a computed audience, once each', async () => {
    const { direct } = setup(withAdmins);
    const reminder = await direct(
      'approval.reminder',
      {
        label: 'Intake review',
        due: '2 h',
        code: 'XPR-00042',
        title: 'Roof repair',
        link: '/requests/XPR-00042',
      },
      ['ops-1', 'ops-1', 'ops-2'],
      REQUEST_ID,
    );
    expect(reminder.map((row) => row.recipientId)).toEqual(['ops-1', 'ops-2']);
    expect(reminder[0]).toMatchObject({
      title: 'Reminder: Intake review due in 2 h',
      message: 'XPR-00042 · Roof repair',
      link: '/requests/XPR-00042',
      requestId: REQUEST_ID,
    });
    const overdue = await direct(
      'approval.overdue',
      {
        label: 'Reliability review',
        code: 'provider-1',
        title: 'Pat Pro',
        link: '/admin/approvals',
      },
      ['admin-1'],
      null,
    );
    expect(overdue[0]).toMatchObject({
      title: 'Overdue: Reliability review · provider-1 · Pat Pro',
      requestId: null,
    });
  });

  it('refuses an event that is not in the catalogue', async () => {
    const { direct } = setup(withAdmins);
    await expect(direct('nope', {}, ['ops-1'], null)).rejects.toThrow(
      'Unknown notification event: nope',
    );
  });
});

describe('NotificationDispatcher message updates (04 §6.20)', () => {
  const STAFF_LINK = '/admin/messages?request=XPR-00042';
  const PARTICIPANT_LINK = '/requests/XPR-00042/messages';
  const members: Member[] = [
    { userId: 'msg-staff', roles: [StaffRole.client_relations] },
    { userId: 'ops-owner', roles: [StaffRole.operations] },
  ];

  it('links staff to the admin Messages inbox and the customer to their own thread', async () => {
    const { message } = setup(members);
    const rows = await message('customer', 'msg-staff');
    expect(rows[CUSTOMER_ID].link).toBe(PARTICIPANT_LINK);
    expect(rows['msg-staff'].link).toBe(STAFF_LINK);
    for (const id of Object.keys(rows)) {
      expect(rows[id].link).toBe(
        id === CUSTOMER_ID ? PARTICIPANT_LINK : STAFF_LINK,
      );
    }
  });

  it('links staff to the admin Messages inbox and the provider user to their own thread', async () => {
    const { message } = setup(members);
    const rows = await message('provider', 'ops-owner');
    expect(rows[PROVIDER_USER_ID].link).toBe(PARTICIPANT_LINK);
    const staffIds = Object.keys(rows).filter((id) => id !== PROVIDER_USER_ID);
    expect(staffIds).not.toHaveLength(0);
    for (const id of staffIds) expect(rows[id].link).toBe(STAFF_LINK);
  });

  it('links every internal-channel recipient to the admin Messages inbox', async () => {
    const { message } = setup(members);
    const rows = await message('internal', 'ops-owner');
    const ids = Object.keys(rows);
    expect(ids).not.toHaveLength(0);
    expect(ids).not.toContain(CUSTOMER_ID);
    expect(ids).not.toContain(PROVIDER_USER_ID);
    for (const id of ids) expect(rows[id].link).toBe(STAFF_LINK);
  });

  it('keeps message bodies and the thread link out of the text', async () => {
    const { message } = setup(members);
    const rows = await message('customer', 'msg-staff');
    for (const row of Object.values(rows)) {
      expect(row.title).toBe('New conversation update');
      expect(row.message).toBe('XPR-00042 has a new conversation update.');
    }
  });
});
