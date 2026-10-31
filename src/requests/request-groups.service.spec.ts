/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- in-memory fakes of the request tables use loose rows */
import type { RequestUser } from '../common/types/request-user';
import type { ActorContext } from '../platform/actor/actor.types';
import {
  catalogRows,
  seededCatalog,
} from '../platform/catalog/catalog.testkit';
import { AppError } from '../platform/errors/app-error';
import { RequestCommandRunner } from './command-runner';
import { childTitle } from './domain/request-group';
import type { RequestGroupCreateDto } from './dto/request-group.dto';
import { IntakeService, trigramSimilarity } from './intake.service';
import { RequestGroupsService } from './request-groups.service';

type Row = Record<string, any>;

const catalog = seededCatalog();
const construction = catalog.roots.find(
  ({ name }) => name === 'Construction',
)!.children;
const waste = catalog.roots.find(
  ({ name }) => name === 'Waste Management',
)!.children;
const PROJECT = 'Renovation of the whole first floor office suite';
const BRIEF = 'Repair the damaged roof above the kitchen.';

const customer: ActorContext = {
  userId: 'customer-1',
  kind: 'customer',
  displayName: 'Customer One',
  platformRoles: ['customer'],
  accountActive: true,
};
const user: RequestUser = {
  id: 'customer-1',
  email: 'customer@example.test',
  role: 'user',
  surfaces: [],
};

function world(
  options: {
    limit?: number;
    uploads?: string[];
    maxOpen?: number;
    override?: number | null;
  } = {},
) {
  const state = {
    groups: [] as Row[],
    requests: [] as Row[],
    attachments: [] as Row[],
    audit: [] as Row[],
    dispatched: [] as Row[],
    idempotency: new Map<string, Row>(),
    order: [] as string[],
  };
  const sequence = { next: 1 };
  let counter = 0;
  const uploads = (options.uploads ?? []).map((id) => ({ id, size: 1000 }));
  const place = (
    id: string,
    kind: string,
    parentId: string | null,
    ancestorIds: string[],
  ) => ({
    id,
    kind,
    name: id,
    parentId,
    active: true,
    serviceable: true,
    ancestorIds,
  });
  const locations = [
    place('state-1', 'state', null, []),
    place('city-1', 'lga', 'state-1', ['state-1']),
    place('district-1', 'area', 'city-1', ['state-1', 'city-1']),
  ];
  const tx = {
    $executeRaw: jest.fn((query: { values?: unknown[] }) => {
      if (
        query.values?.some(
          (value) =>
            typeof value === 'string' &&
            value.startsWith('open-request-limit:'),
        )
      )
        state.order.push('lock');
      return Promise.resolve(1);
    }),
    user: {
      findUnique: jest.fn(() =>
        Promise.resolve({ openRequestLimit: options.override ?? null }),
      ),
    },
    $queryRaw: jest.fn(() =>
      Promise.resolve([{ nextval: BigInt(sequence.next++) }]),
    ),
    location: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(locations.find(({ id }) => id === where.id) ?? null),
      ),
      findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(locations.filter(({ id }) => where.id.in.includes(id))),
      ),
    },
    catalogService: {
      findMany: jest.fn().mockResolvedValue(catalogRows(catalog)),
    },
    requestGroup: {
      create: jest.fn(({ data }: { data: Row }) => {
        const row: Row = { id: `group-${state.groups.length + 1}`, ...data };
        state.groups.push(row);
        return Promise.resolve({
          id: row.id,
          ref: row.ref,
          title: row.title,
        });
      }),
    },
    serviceRequest: {
      count: jest.fn(({ where }: { where: Row }) => {
        state.order.push('count');
        return Promise.resolve(
          state.requests.filter(
            (row) =>
              row.ownerId === where.ownerId &&
              !where.status.notIn.includes(row.status),
          ).length,
        );
      }),
      findMany: jest.fn(({ where }: { where: Row }) =>
        Promise.resolve(
          state.requests
            .filter(
              (row) =>
                row.ownerId === where.ownerId &&
                row.service === where.service &&
                row.locationId === where.locationId &&
                where.status.in.includes(row.status) &&
                row.createdAt >= where.createdAt.gte &&
                !(where.id?.notIn ?? []).includes(row.id),
            )
            .map(({ id, number, title }) => ({ id, number, title })),
        ),
      ),
      create: jest.fn(({ data }: { data: Row }) => {
        state.order.push('insert');
        counter += 1;
        const row = {
          ...data,
          id: `req-${counter}`,
          number: counter,
          createdAt: new Date(),
        };
        state.requests.push(row);
        return Promise.resolve(row);
      }),
    },
    upload: {
      findMany: jest.fn(({ where }: { where: Row }) =>
        Promise.resolve(uploads.filter(({ id }) => where.id.in.includes(id))),
      ),
    },
    requestAttachment: {
      createMany: jest.fn(({ data }: { data: Row[] }) => {
        state.attachments.push(...data);
        return Promise.resolve({ count: data.length });
      }),
    },
    auditLog: {
      createMany: jest.fn(({ data }: { data: Row[] }) => {
        state.audit.push(...data);
        return Promise.resolve({ count: data.length });
      }),
    },
  };
  const prisma = {
    $transaction: jest.fn(
      async (callback: (t: unknown) => Promise<unknown>) => {
        const before = structuredClone(state);
        try {
          return await callback(tx);
        } catch (error) {
          Object.assign(state, before);
          throw error;
        }
      },
    ),
  };
  const loader = {
    load: jest.fn((_tx: unknown, id: string) => {
      const row = state.requests.find((item) => item.id === id);
      return Promise.resolve(
        row
          ? {
              row: { ...row, staffOwnerId: null },
              snapshot: {
                id: row.id,
                number: `XPR-${String(row.number).padStart(5, '0')}`,
              },
            }
          : null,
      );
    }),
  };
  const idempotency = {
    hashRequest: jest.fn(() => 'hash'),
    lookup: jest.fn((_user: string, key: string) =>
      Promise.resolve(state.idempotency.get(key) ?? null),
    ),
    store: jest.fn(
      (
        _user: string,
        key: string,
        _hash: string,
        status: number,
        body: unknown,
      ) => {
        state.idempotency.set(key, { status, body });
        return Promise.resolve();
      },
    ),
  };
  const dispatcher = {
    dispatch: jest.fn(
      (_tx: unknown, event: string, params: Row, context: Row) => {
        state.dispatched.push({ event, params, requestId: context.requestId });
        return Promise.resolve();
      },
    ),
  };
  const timers = { kick: jest.fn(), start: jest.fn(), stop: jest.fn() };
  const outbox = { kick: jest.fn() };
  const approvals = { open: jest.fn(), close: jest.fn() };
  const runner = new RequestCommandRunner(
    prisma as never,
    loader as never,
    {
      snapshot: jest.fn().mockResolvedValue([
        {
          key: 'request.maxServicesPerSubmission',
          value: options.limit ?? 5,
        },
        ...(options.maxOpen === undefined
          ? []
          : [{ key: 'request.maxOpenPerCustomer', value: options.maxOpen }]),
      ]),
    } as never,
    idempotency as never,
    dispatcher as never,
    timers as never,
    outbox as never,
    approvals as never,
  );
  (runner as unknown as { project: unknown }).project = jest.fn(
    (row: Row, snapshot: Row) => ({
      id: snapshot.number,
      version: 1,
      title: row.title,
    }),
  );
  const attach = jest.fn((_tx: unknown, ids: string[], ..._rest: unknown[]) =>
    Promise.resolve(ids.map((id) => ({ id }))),
  );
  const actors = { resolve: jest.fn().mockResolvedValue(customer) };
  const intake = new IntakeService(
    actors as never,
    runner,
    idempotency as never,
    { attach } as never,
  );
  const service = new RequestGroupsService(
    actors as never,
    runner,
    idempotency as never,
    intake,
  );
  return {
    state,
    sequence,
    intake,
    tx,
    timers,
    outbox,
    attach,
    service,
    create: (dto: Partial<RequestGroupCreateDto>, key = 'key-1') =>
      service.create(user, body(dto), key, '/request-groups'),
    existing: (row: Row) =>
      state.requests.push({
        id: 'req-existing',
        number: 99,
        ownerId: 'customer-1',
        status: 'submitted',
        createdAt: new Date(),
        ...row,
      }),
  };
}

const card = (index: number, over: Row = {}) => ({
  serviceId: construction[index].id,
  answers: {},
  description: BRIEF,
  budget: 0,
  ...over,
});

function body(
  over: Partial<RequestGroupCreateDto> = {},
): RequestGroupCreateDto {
  return {
    title: PROJECT,
    locationId: 'district-1',
    address: '12 Example Road',
    phone: '08031234567',
    contactMethod: 'phone',
    attachments: [],
    services: [card(0), card(1)],
    ...over,
  };
}

async function failure(run: Promise<unknown>): Promise<AppError> {
  try {
    await run;
  } catch (error) {
    return error as AppError;
  }
  throw new Error('Expected the submission to be refused.');
}

const nothingCreated = (w: ReturnType<typeof world>) => {
  expect(w.state.groups).toEqual([]);
  expect(w.state.requests).toEqual([]);
  expect(w.state.audit).toEqual([]);
  expect(w.state.dispatched).toEqual([]);
  expect(w.state.idempotency.size).toBe(0);
};

describe('POST /request-groups', () => {
  it('creates a group and one request per service, in form order', async () => {
    const w = world();
    const { status, body: result } = await w.create({});

    expect(status).toBe(201);
    expect(result.group).toEqual({
      id: 'group-1',
      ref: 'XPG-00001',
      title: PROJECT,
    });
    expect(result.requests.map(({ id }) => id)).toEqual([
      'XPR-00001',
      'XPR-00002',
    ]);
    expect(result.warnings).toBeUndefined();
    expect(w.state.requests).toHaveLength(2);
    for (const [position, row] of w.state.requests.entries()) {
      expect(row).toMatchObject({
        groupId: 'group-1',
        groupPosition: position,
        status: 'submitted',
        intakeState: 'pending',
        version: 1,
        dispatchMode: 'auto',
        ownerId: 'customer-1',
        customerName: 'Customer One',
        locationId: 'district-1',
        address: '12 Example Road',
        phone: '+2348031234567',
        description: BRIEF,
      });
    }
    expect(w.state.requests.map(({ serviceId }) => serviceId)).toEqual([
      construction[0].id,
      construction[1].id,
    ]);
    expect(w.state.groups).toEqual([
      {
        id: 'group-1',
        ref: 'XPG-00001',
        ownerId: 'customer-1',
        title: PROJECT,
      },
    ]);
    expect(w.timers.kick).not.toHaveBeenCalled();
    expect(w.outbox.kick).toHaveBeenCalledTimes(1);
  });

  it('starts the intake and unclaimed deadlines for every request', async () => {
    const w = world();
    await w.create({});
    expect(
      w.state.dispatched.filter(({ event }) => event === 'request.submitted'),
    ).toHaveLength(2);
  });

  it('derives each request title from the project title and the leaf name', async () => {
    const w = world();
    const { body: result } = await w.create({});
    expect(w.state.requests.map(({ title }) => title)).toEqual([
      `${PROJECT} — ${construction[0].name}`,
      `${PROJECT} — ${construction[1].name}`,
    ]);
    expect(result.requests.map(({ title }) => title)).toEqual(
      w.state.requests.map(({ title }) => title),
    );
  });

  it('cuts the project part of a long title so every request title fits 120 characters', async () => {
    const w = world();
    const long = 'L'.repeat(120);
    await w.create({ title: long });
    expect(w.state.groups[0].title).toBe(long);
    for (const [index, row] of w.state.requests.entries()) {
      expect(row.title.length).toBeLessThanOrEqual(120);
      expect(row.title).toBe(childTitle(long, construction[index].name));
      expect(row.title.endsWith(` — ${construction[index].name}`)).toBe(true);
    }
  });

  it('applies the 3 to 120 character title check to the project title', async () => {
    for (const title of ['ab', 'T'.repeat(121)]) {
      const w = world();
      const error = await failure(w.create({ title }));
      expect(error.message).toBe(
        'Add a title and a project brief of at least 20 characters.',
      );
      expect(error.details).toEqual({ field: 'title' });
      nothingCreated(w);
    }
  });

  it('creates no group for a bundle of one service and behaves like a single request', async () => {
    const w = world();
    const { status, body: result } = await w.create({ services: [card(0)] });

    expect(status).toBe(201);
    expect(result.group).toBeNull();
    expect(result.requests).toHaveLength(1);
    expect(w.tx.$queryRaw).not.toHaveBeenCalled();
    expect(w.tx.requestGroup.create).not.toHaveBeenCalled();
    expect(w.state.requests[0].title).toBe(PROJECT);
    expect(w.state.requests[0]).not.toHaveProperty('groupId');
    expect(w.state.requests[0]).not.toHaveProperty('groupPosition');
    expect(w.state.dispatched.map(({ event }) => event)).toEqual([
      'request.received',
      'request.submitted',
    ]);
    expect(w.state.audit[0].metadata).not.toHaveProperty('groupId');
  });

  it('refuses more services than request.maxServicesPerSubmission, reading the limit from settings', async () => {
    const three = [card(0), card(1), card(2)];
    const small = world({ limit: 2 });
    const error = await failure(small.create({ services: three }));
    expect(error.getStatus()).toBe(422);
    expect(error.message).toBe('You can request up to 2 services at a time.');
    nothingCreated(small);

    const wide = world({ limit: 3 });
    const { body: result } = await wide.create({ services: three });
    expect(result.requests).toHaveLength(3);
    expect(result.group?.ref).toBe('XPG-00001');
  });

  it('refuses an empty list of services', async () => {
    const w = world();
    const error = await failure(w.create({ services: [] }));
    expect(error.message).toBe('You can request up to 5 services at a time.');
    nothingCreated(w);
    expect(w.tx.location.findMany).not.toHaveBeenCalled();
  });

  it('refuses the same service twice before checking any service', async () => {
    const w = world();
    const error = await failure(
      w.create({ services: [card(0, { description: 'short' }), card(0)] }),
    );
    expect(error.message).toBe(
      'Add each service once. Use the quantity field to ask for more than one.',
    );
    nothingCreated(w);
  });

  it('prefixes a failing service field with the card index and creates nothing', async () => {
    const w = world();
    const error = await failure(
      w.create({ services: [card(0), card(1, { description: 'short' })] }),
    );
    expect(error.getStatus()).toBe(422);
    expect(error.message).toBe(
      'Add a title and a project brief of at least 20 characters.',
    );
    expect(error.details).toEqual({ field: 'services[1].description' });
    nothingCreated(w);
    expect(w.sequence.next).toBe(1);
  });

  it('points an answer failure at services[i].answers.<questionId>', async () => {
    const w = world();
    const error = await failure(
      w.create({
        services: [
          card(0),
          { ...card(0), serviceId: waste[0].id, answers: {} },
        ],
      }),
    );
    expect(error.message).toBe('Complete estimated quantity and unit.');
    expect(error.details).toEqual({
      field: 'services[1].answers.q:svc:Waste Management:quantity',
    });
    nothingCreated(w);
  });

  it('keeps shared field failures on the shared field name', async () => {
    const w = world();
    const error = await failure(w.create({ phone: '123' }));
    expect(error.message).toBe('Enter a valid Nigerian phone number.');
    expect(error.details).toEqual({ field: 'phone' });
  });

  it('rejects a provider preference with the existing message', async () => {
    const own = world();
    const first = await failure(
      own.create({
        services: [card(0), card(1, { providerId: 'provider-1' })],
      }),
    );
    expect(first.message).toBe(
      'XPro assigns a verified provider for you. Remove the provider preference.',
    );
    expect(first.details).toEqual({ field: 'services[1].providerId' });
    nothingCreated(own);

    const shared = world();
    const second = await failure(shared.create({ preferredProviderId: 'p-1' }));
    expect(second.message).toBe(first.message);
    expect(second.details).toEqual({ field: 'preferredProviderId' });
  });

  it('rolls everything back, including the group, when the second request fails', async () => {
    const w = world({ uploads: ['file-1'] });
    const error = await failure(
      w.create({
        services: [
          card(0, { attachments: [{ id: 'file-1' }] }),
          card(1, { attachments: [{ id: 'never-uploaded' }] }),
        ],
      }),
    );

    expect(error.getStatus()).toBe(422);
    expect(error.message).toBe(
      "One of your files didn't finish uploading. Remove it and try again.",
    );
    expect(error.details).toEqual({ field: 'services[1].attachments' });
    expect(w.tx.requestGroup.create).toHaveBeenCalledTimes(1);
    expect(w.tx.serviceRequest.create).toHaveBeenCalledTimes(2);
    nothingCreated(w);
    expect(w.state.attachments).toEqual([]);
    expect(w.outbox.kick).not.toHaveBeenCalled();
    expect(w.timers.kick).not.toHaveBeenCalled();
    // The sequence may skip: the reference taken by the rolled-back group is not reused.
    expect(w.sequence.next).toBe(2);
  });

  it('sends one receipt for the bundle and none per request', async () => {
    const w = world();
    await w.create({});
    const events = w.state.dispatched.map(({ event }) => event);
    expect(
      events.filter((event) => event === 'request.group_received'),
    ).toEqual(['request.group_received']);
    expect(events).not.toContain('request.received');
    expect(
      events.filter((event) => event === 'request.submitted'),
    ).toHaveLength(2);
    expect(
      w.state.dispatched.find(({ event }) => event === 'request.group_received')
        ?.params,
    ).toEqual({ count: 2, projectTitle: PROJECT });
  });

  it('writes Request submitted for every request with the group id in its metadata', async () => {
    const w = world();
    await w.create({});
    const rows = w.state.audit.filter(
      ({ action }) => action === 'Request submitted',
    );
    expect(rows).toHaveLength(2);
    expect(rows.map(({ entityId }) => entityId)).toEqual(['req-1', 'req-2']);
    for (const row of rows)
      expect(row.metadata).toMatchObject({
        groupId: 'group-1',
        command: 'request.create',
      });
  });

  it('never flags requests from the same submission as duplicates of each other', async () => {
    const w = world();
    const titles = [0, 1].map((i) => childTitle(PROJECT, construction[i].name));
    expect(trigramSimilarity(titles[0], titles[1])).toBeGreaterThanOrEqual(0.6);

    const { body: result } = await w.create({});

    expect(result.warnings).toBeUndefined();
    for (const row of w.state.requests)
      expect(row.possibleDuplicateOf).toBeUndefined();
    for (const row of w.state.audit) expect(row.metadata.flags).toEqual([]);
  });

  it("still checks each request against the owner's earlier requests and lists the warning", async () => {
    const w = world();
    w.existing({
      service: 'Construction',
      locationId: 'district-1',
      title: childTitle(PROJECT, construction[0].name),
    });

    const { body: result } = await w.create({});

    expect(w.state.requests[1].possibleDuplicateOf).toBe('req-existing');
    expect(result.warnings?.[0]).toEqual({
      requestId: 'XPR-00001',
      message:
        "You already have a similar open request (XPR-00099). XPro will check it isn't a duplicate.",
    });
    for (const row of w.state.requests.slice(1))
      expect(row.possibleDuplicateOf).toBe('req-existing');
    expect(
      w.state.audit.find(({ entityId }) => entityId === 'req-1')?.metadata,
    ).toMatchObject({
      flags: ['possible_duplicate'],
      changes: { possibleDuplicateOf: 'XPR-00099' },
    });
  });

  it("attaches each service's own files to its own request and nothing is shared", async () => {
    const w = world({ uploads: ['own-0', 'own-1'] });
    await w.create({
      services: [
        card(0, { attachments: [{ id: 'own-0' }] }),
        card(1, { attachments: [{ id: 'own-1' }] }),
      ],
    });
    expect(w.attach.mock.calls.map((call) => [call[5], call[1]])).toEqual([
      ['req-1', ['own-0']],
      ['req-2', ['own-1']],
    ]);
  });

  it('refuses a project-level file and creates nothing (MS-8)', async () => {
    const w = world({ uploads: ['shared'] });
    const error = await failure(
      w.create({ attachments: [{ id: 'shared' }] as never }),
    );
    expect(error.getStatus()).toBe(422);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.message).toBe('Add files to the service they belong to.');
    expect(error.details).toEqual({ field: 'attachments' });
    expect(w.tx.serviceRequest.create).not.toHaveBeenCalled();
    nothingCreated(w);
  });

  it('puts the project-file check after the services count and duplicate checks', async () => {
    const w = world({ limit: 2 });
    const tooMany = await failure(
      w.create({
        attachments: [{ id: 'shared' }] as never,
        services: [card(0), card(1), card(2)],
      }),
    );
    expect(tooMany.details).toEqual({ field: 'services' });
    const repeated = await failure(
      w.create({
        attachments: [{ id: 'shared' }] as never,
        services: [card(0), card(0)],
      }),
    );
    expect(repeated.details).toEqual({ field: 'services[1].serviceId' });
  });

  it('replays a completed submission for the same key without creating again', async () => {
    const w = world();
    const first = await w.create({});
    const again = await w.create({});
    expect(again).toEqual(first);
    expect(w.state.requests).toHaveLength(2);
    expect(w.state.groups).toHaveLength(1);
    expect(w.sequence.next).toBe(2);
  });

  it('refuses a customer account that is not active', async () => {
    const w = world();
    (
      w.service as unknown as { actors: { resolve: jest.Mock } }
    ).actors.resolve.mockResolvedValueOnce({
      ...customer,
      accountActive: false,
    });
    const error = await failure(w.create({}));
    expect(error.getStatus()).toBe(403);
    nothingCreated(w);
  });
});

describe('open-request limit (MS-6, MS-7)', () => {
  type World = ReturnType<typeof world>;
  const single = (w: World, over: Row = {}) =>
    w.intake.create(
      user,
      {
        title: PROJECT,
        serviceId: construction[0].id,
        locationId: 'district-1',
        address: '12 Example Road',
        phone: '08031234567',
        contactMethod: 'phone',
        description: BRIEF,
        budget: 0,
        answers: {},
        attachments: [],
        ...over,
      } as never,
      'single-key',
      '/requests',
    );
  const bundle = (w: World, count: number, over: Row = {}) =>
    w.create({
      services: Array.from({ length: count }, (_, index) => card(index)),
      ...over,
    });
  const open = (w: World, count: number, status = 'submitted') => {
    for (let index = 0; index < count; index += 1)
      w.existing({
        id: `open-${status}-${index}`,
        number: 100 + index,
        status,
      });
  };
  const untouched = (w: World, existing: number) => {
    expect(w.tx.serviceRequest.create).not.toHaveBeenCalled();
    expect(w.tx.requestGroup.create).not.toHaveBeenCalled();
    expect(w.state.requests).toHaveLength(existing);
    expect(w.state.groups).toEqual([]);
    expect(w.state.audit).toEqual([]);
    expect(w.state.dispatched).toEqual([]);
    expect(w.state.idempotency.size).toBe(0);
  };

  it('refuses a single create at the platform limit with 422 OPEN_REQUEST_LIMIT and the details', async () => {
    const w = world({ maxOpen: 3 });
    open(w, 3);
    const error = await failure(single(w));
    expect(error.getStatus()).toBe(422);
    expect(error.code).toBe('OPEN_REQUEST_LIMIT');
    expect(error.message).toBe(
      'You already have 3 open requests, the most XPro allows at a time. Wait for one to finish, or cancel one, before sending another.',
    );
    expect(error.details).toEqual({ limit: 3, open: 3, remaining: 0 });
    untouched(w, 3);
  });

  it('falls back to the default of 3 when the setting is not in the snapshot', async () => {
    const w = world();
    open(w, 3);
    const error = await failure(single(w));
    expect(error.details).toEqual({ limit: 3, open: 3, remaining: 0 });
    const ok = world();
    open(ok, 2);
    await expect(single(ok)).resolves.toMatchObject({ status: 201 });
  });

  it('uses the limit-1 message when the limit is 1', async () => {
    const w = world({ maxOpen: 1 });
    open(w, 1);
    const error = await failure(single(w));
    expect(error.message).toBe(
      'You already have an open request. Wait for it to finish, or cancel it, before sending another.',
    );
    expect(error.details).toEqual({ limit: 1, open: 1, remaining: 0 });
    untouched(w, 1);
  });

  it("lets a customer's override beat the platform setting in both directions", async () => {
    const higher = world({ maxOpen: 1, override: 3 });
    open(higher, 2);
    await expect(single(higher)).resolves.toMatchObject({ status: 201 });

    const lower = world({ maxOpen: 5, override: 1 });
    open(lower, 1);
    const error = await failure(bundle(lower, 2));
    expect(error.code).toBe('OPEN_REQUEST_LIMIT');
    expect(error.details).toEqual({ limit: 1, open: 1, remaining: 0 });
    untouched(lower, 1);
  });

  it('does not count closed, cancelled or rejected requests, but counts one being cancelled', async () => {
    const w = world({ maxOpen: 1 });
    for (const status of ['closed', 'cancelled', 'rejected'])
      open(w, 1, status);
    await expect(single(w)).resolves.toMatchObject({ status: 201 });

    const counted = world({ maxOpen: 1 });
    open(counted, 1, 'cancelling');
    const error = await failure(single(counted));
    expect(error.details).toEqual({ limit: 1, open: 1, remaining: 0 });
  });

  it("does not count another customer's requests", async () => {
    const w = world({ maxOpen: 1 });
    w.existing({ ownerId: 'someone-else' });
    await expect(single(w)).resolves.toMatchObject({ status: 201 });
  });

  it('refuses a bundle that needs more than the remaining room, singular and plural', async () => {
    const one = world({ maxOpen: 3 });
    open(one, 2);
    const singular = await failure(bundle(one, 2));
    expect(singular.getStatus()).toBe(422);
    expect(singular.code).toBe('OPEN_REQUEST_LIMIT');
    expect(singular.message).toBe(
      'You can have 3 open requests at a time and you have 2. Remove 1 service from this submission, or finish an open request first.',
    );
    expect(singular.details).toEqual({ limit: 3, open: 2, remaining: 1 });
    untouched(one, 2);

    const many = world({ maxOpen: 3 });
    open(many, 1);
    const plural = await failure(bundle(many, 4));
    expect(plural.message).toBe(
      'You can have 3 open requests at a time and you have 1. Remove 2 services from this submission, or finish an open request first.',
    );
    expect(plural.details).toEqual({ limit: 3, open: 1, remaining: 2 });
    untouched(many, 1);
  });

  it('refuses a bundle at remaining 0 with the open-count message', async () => {
    const w = world({ maxOpen: 3 });
    open(w, 3);
    const error = await failure(bundle(w, 2));
    expect(error.message).toBe(
      'You already have 3 open requests, the most XPro allows at a time. Wait for one to finish, or cancel one, before sending another.',
    );
    untouched(w, 3);
  });

  it('accepts a bundle that exactly fills the remaining room', async () => {
    const w = world({ maxOpen: 3 });
    open(w, 1);
    const { status, body: result } = await bundle(w, 2);
    expect(status).toBe(201);
    expect(result.requests).toHaveLength(2);
  });

  it('treats a bundle of one exactly like a single create', async () => {
    for (const [maxOpen, existing] of [
      [1, 1],
      [3, 3],
    ] as const) {
      const a = world({ maxOpen });
      open(a, existing);
      const fromSingle = await failure(single(a));
      const b = world({ maxOpen });
      open(b, existing);
      const fromBundle = await failure(bundle(b, 1));
      expect(fromBundle.getStatus()).toBe(fromSingle.getStatus());
      expect(fromBundle.code).toBe(fromSingle.code);
      expect(fromBundle.message).toBe(fromSingle.message);
      expect(fromBundle.details).toEqual(fromSingle.details);
    }
    const c = world({ maxOpen: 1 });
    await expect(bundle(c, 1)).resolves.toMatchObject({ status: 201 });
    const d = world({ maxOpen: 1 });
    await expect(single(d)).resolves.toMatchObject({ status: 201 });
  });

  it('takes the owner lock, then counts, before anything is inserted', async () => {
    const single1 = world({ maxOpen: 3 });
    await single(single1);
    expect(single1.state.order.slice(0, 3)).toEqual([
      'lock',
      'count',
      'insert',
    ]);

    const group = world({ maxOpen: 3 });
    await bundle(group, 2);
    expect(group.state.order.slice(0, 2)).toEqual(['lock', 'count']);
    expect(group.state.order.indexOf('insert')).toBeGreaterThan(
      group.state.order.indexOf('count'),
    );
    expect(group.tx.requestGroup.create).toHaveBeenCalledTimes(1);
  });

  it('keys the lock on the owner id', async () => {
    const w = world({ maxOpen: 3 });
    await single(w);
    const values = w.tx.$executeRaw.mock.calls.flatMap(
      ([query]) => (query as { values: unknown[] }).values,
    );
    expect(values).toContain('open-request-limit:customer-1');
  });

  it('reports intake validation failures before the limit', async () => {
    const w = world({ maxOpen: 1 });
    open(w, 1);
    const fromSingle = await failure(single(w, { phone: '123' }));
    expect(fromSingle.message).toBe('Enter a valid Nigerian phone number.');
    const fromBundle = await failure(bundle(w, 2, { phone: '123' }));
    expect(fromBundle.message).toBe('Enter a valid Nigerian phone number.');
    expect(w.state.order).not.toContain('lock');
  });
});
