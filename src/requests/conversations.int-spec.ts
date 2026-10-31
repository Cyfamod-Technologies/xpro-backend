import { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import type { Server } from 'http';
import {
  createStaff,
  createUser,
  deleteTestUsers,
} from '../../test/integration/users';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ExceptionLoggingFilter } from '../common/filters/exception-logging.filter';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { ActorService } from '../platform/actor/actor.service';
import type { ActorContext } from '../platform/actor/actor.types';
import { AppError } from '../platform/errors/app-error';
import { LIFE_CAMP_ID } from '../platform/locations/locations.testkit';
import { SettingsService } from '../platform/settings/settings.service';
import { PrismaModule } from '../prisma/prisma.module';
import type { StaffPermission } from '../staff/staff-permissions';
import { ConversationsController } from './conversations.controller';
import { ConversationsService } from './conversations.service';
import type { ConversationList } from './conversations.service';
import { RequestListLoader } from './request-list.loader';
import { formatRequestId } from './domain/statuses';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require('supertest') as typeof import('supertest');

const prisma = new PrismaClient();
const RUN = randomUUID().slice(0, 8);
const T0 = Date.parse('2026-10-01T10:00:00.000Z');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);

type Fixture = {
  id: string;
  number: number;
  code: string;
};

describe('GET /admin/conversations (integration)', () => {
  let app: INestApplication;
  let ownerUser: { id: string };
  let ops: { id: string };
  let finance: { id: string };
  let pricing: { id: string };
  let suspended: { id: string };
  let plainUser: { id: string };
  let opsName: string;
  const requestIds: string[] = [];
  const profileIds: string[] = [];
  const locationIds: string[] = [];
  const catalogIds: string[] = [];
  const f: Record<string, Fixture> = {};
  const server = () => app.getHttpServer() as Server;

  const withHeader = (userId: string) =>
    request(server()).get('/admin/conversations').set('x-user', userId);

  function serviceFor(permissions: StaffPermission[]) {
    const actor: ActorContext = {
      userId: ops.id,
      kind: 'staff',
      displayName: 'Stub',
      platformRoles: ['staff'],
      accountActive: true,
      staff: {
        status: 'active',
        roles: [],
        permissions: new Set(permissions),
        canOwn: true,
        isSuperAdmin: false,
        permVersion: 1,
      },
    };
    return new ConversationsService(
      prisma as never,
      { resolve: () => Promise.resolve(actor) } as never,
      new RequestListLoader(),
      { snapshot: () => Promise.resolve([]) } as never,
    );
  }
  const list = (
    permissions: StaffPermission[],
    query: Record<string, unknown> = {},
  ) =>
    serviceFor(permissions).list({ id: ops.id } as never, {
      q: RUN,
      limit: 50,
      ...query,
    });
  const codes = (result: ConversationList) =>
    result.data.map((item) => item.requestId);

  async function createRequest(
    key: string,
    options: {
      status?: 'in_progress' | 'closed' | 'under_review' | 'quoted';
      title?: string;
      description?: string;
      customerName?: string;
      service?: string;
      locationId?: string;
      serviceId?: string;
      serviceRootId?: string;
      staffOwnerId?: string;
    } = {},
  ) {
    const row = await prisma.serviceRequest.create({
      data: {
        ownerId: ownerUser.id,
        customerName: options.customerName ?? `Chika ${RUN}`,
        title: options.title ?? `${RUN} ${key}`,
        service: options.service ?? 'Maintenance',
        locationId: options.locationId ?? LIFE_CAMP_ID,
        address: '1 Test Street',
        phone: '+2348012345678',
        description: options.description ?? 'Plain brief.',
        status: options.status ?? 'in_progress',
        serviceId: options.serviceId,
        serviceRootId: options.serviceRootId,
        staffOwnerId: options.staffOwnerId,
      },
    });
    requestIds.push(row.id);
    f[key] = {
      id: row.id,
      number: row.number,
      code: formatRequestId(row.number),
    };
    return f[key];
  }

  async function say(
    key: string,
    channel: 'customer' | 'provider' | 'internal',
    authorRole: 'customer' | 'provider' | 'staff',
    minutes: number,
    text: string,
    extra: { providerId?: string; authorId?: string } = {},
  ) {
    await prisma.requestMessage.create({
      data: {
        requestId: f[key].id,
        channel,
        providerId: channel === 'provider' ? extra.providerId : null,
        authorId:
          extra.authorId ?? (authorRole === 'staff' ? ops.id : ownerUser.id),
        authorRole,
        text,
        createdAt: at(minutes),
      },
    });
  }

  async function provider(businessName: string | null) {
    const user = await createUser(prisma);
    const profile = await prisma.providerProfile.create({
      data: {
        userId: user.id,
        phone: '+2348000000000',
        trade: 'Plumber',
        services: [],
        skills: {},
        workingHours: {},
        bio: 'Integration test provider.',
        businessName,
      },
    });
    profileIds.push(profile.id);
    return { user, profile };
  }

  async function assign(
    key: string,
    who: { user: { id: string }; profile: { id: string } },
    status: 'accepted' | 'replaced' | 'declined',
    minutes: number,
  ) {
    await prisma.assignment.create({
      data: {
        requestId: f[key].id,
        providerId: who.profile.id,
        providerUserId: who.user.id,
        status,
        source: 'manual',
        offeredAt: at(minutes),
        expiresAt: at(minutes + 600),
        createdAt: at(minutes),
      },
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      controllers: [ConversationsController],
      providers: [
        ConversationsService,
        ActorService,
        RequestListLoader,
        {
          provide: SettingsService,
          useValue: { snapshot: () => Promise.resolve([]) },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: {
          switchToHttp: () => {
            getRequest: () => {
              headers: Record<string, string>;
              user?: { id: string };
            };
          };
        }) => {
          const req = context.switchToHttp().getRequest();
          req.user = { id: req.headers['x-user'] };
          return true;
        },
      })
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new ExceptionLoggingFilter());
    app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
    await app.init();

    ownerUser = await createUser(prisma);
    ops = await createStaff(prisma, ['operations']);
    finance = await createStaff(prisma, ['finance']);
    pricing = await createStaff(prisma, ['pricing']);
    suspended = await createStaff(prisma, ['operations'], {
      status: 'suspended',
    });
    plainUser = await createUser(prisma);
    const opsRow = await prisma.user.findUniqueOrThrow({
      where: { id: ops.id },
    });
    opsName = `${opsRow.firstName} ${opsRow.lastName}`;

    // --- catalog and locations for the search cases
    const root = await prisma.catalogService.create({
      data: { name: `${RUN} Plumbing`, depth: 0 },
    });
    const leaf = await prisma.catalogService.create({
      data: { name: `${RUN} Leak repair`, parentId: root.id, depth: 1 },
    });
    catalogIds.push(leaf.id, root.id);
    const state = await prisma.location.create({
      data: { kind: 'state', name: `${RUN} Lagosia` },
    });
    const lga = await prisma.location.create({
      data: {
        kind: 'lga',
        name: `${RUN} Ikejaland`,
        parentId: state.id,
        ancestorIds: [state.id],
      },
    });
    const area = await prisma.location.create({
      data: {
        kind: 'area',
        name: `${RUN} Ikejaville`,
        parentId: lga.id,
        ancestorIds: [state.id, lga.id],
      },
    });
    // Children first: requests and locations reference each other with RESTRICT.
    locationIds.push(area.id, lga.id, state.id);

    // R1: customer asks, XPro answers, customer asks twice more, then an internal note (XPro last).
    await createRequest('r1', {
      title: `${RUN} Roof replacement`,
      description: 'Replace the corrugated roof sheets.',
      serviceId: leaf.id,
      serviceRootId: root.id,
      locationId: area.id,
      staffOwnerId: ops.id,
      customerName: `Chika ${RUN}`,
    });
    await say('r1', 'customer', 'customer', 0, 'Can you start earlier?');
    await say('r1', 'customer', 'staff', 1, 'Checking now');
    await say('r1', 'customer', 'customer', 2, 'Thursday would be ideal.');
    await say('r1', 'customer', 'customer', 3, 'Hello?');
    await say('r1', 'internal', 'staff', 4, 'Customer is chasing, call them');

    // R2: a note in the middle of the run. Waiting = the two customer messages after the note.
    await createRequest('r2', {
      title: `${RUN} Generator hire`,
      status: 'under_review',
    });
    await say('r2', 'customer', 'customer', 10, 'First question');
    await say('r2', 'internal', 'staff', 11, 'Looking into it');
    await say('r2', 'customer', 'customer', 12, 'Second question');
    await say('r2', 'customer', 'customer', 13, 'x'.repeat(200));

    // R3: customer messages only; a provider-only viewer must not see it.
    await createRequest('r3', { title: `${RUN} Painting`, status: 'quoted' });
    await say('r3', 'customer', 'customer', 20, 'Only the customer channel');

    // R4: closed request with a provider thread; the current provider is accepted.
    const tunde = await provider(`Tunde Roofing ${RUN}`);
    await createRequest('r4', { title: `${RUN} Closed job`, status: 'closed' });
    await assign('r4', tunde, 'accepted', 25);
    await say('r4', 'provider', 'provider', 30, 'Gate is locked', {
      providerId: tunde.profile.id,
      authorId: tunde.user.id,
    });

    // R5: replaced provider. The old thread is newer than the current provider's.
    const old = await provider(`Old Provider ${RUN}`);
    const current = await provider(`Current Provider ${RUN}`);
    await createRequest('r5', { title: `${RUN} Replaced provider` });
    await assign('r5', old, 'replaced', 40);
    await assign('r5', current, 'accepted', 41);
    await say('r5', 'provider', 'provider', 50, 'Current provider asks', {
      providerId: current.profile.id,
      authorId: current.user.id,
    });
    await say('r5', 'provider', 'staff', 51, 'XPro Dispatch replies', {
      providerId: current.profile.id,
    });
    await say('r5', 'provider', 'provider', 52, 'Current provider again', {
      providerId: current.profile.id,
      authorId: current.user.id,
    });
    await say('r5', 'provider', 'provider', 60, 'Old provider speaks late', {
      providerId: old.profile.id,
      authorId: old.user.id,
    });
    await say('r5', 'provider', 'provider', 61, 'Old provider again', {
      providerId: old.profile.id,
      authorId: old.user.id,
    });

    // R6: the latest assignment was declined, so no provider thread is current.
    const gone = await provider(null);
    await createRequest('r6', { title: `${RUN} No current provider` });
    await assign('r6', gone, 'declined', 70);
    await say('r6', 'provider', 'provider', 71, 'Declined provider note', {
      providerId: gone.profile.id,
      authorId: gone.user.id,
    });

    // R7: a request with no messages at all.
    await createRequest('r7', { title: `${RUN} Silent` });

    // R8 and R9: the same last-message time, so paging must break the tie by number.
    await createRequest('r8', { title: `${RUN} Tie A`, status: 'quoted' });
    await createRequest('r9', { title: `${RUN} Tie B`, status: 'quoted' });
    await say('r8', 'customer', 'customer', 80, 'Tie A');
    await say('r9', 'customer', 'customer', 80, 'Tie B');

    // R10: LIKE metacharacters in the title.
    await createRequest('r10', { title: `${RUN} Pipe_100% done` });
    await createRequest('r11', { title: `${RUN} PipeX100Z done` });
    await say('r10', 'customer', 'customer', 90, 'wildcards');
    await say('r11', 'customer', 'customer', 91, 'not a wildcard match');
  });

  afterAll(async () => {
    await prisma.serviceRequest.deleteMany({
      where: { id: { in: requestIds } },
    });
    await prisma.providerProfile.deleteMany({
      where: { id: { in: profileIds } },
    });
    for (const id of catalogIds)
      await prisma.catalogService.deleteMany({ where: { id } });
    for (const id of locationIds)
      await prisma.location.deleteMany({ where: { id } });
    await deleteTestUsers(prisma);
    await app.close();
    await prisma.$disconnect();
  });

  describe('permissions', () => {
    const ALL: StaffPermission[] = [
      'message.customer',
      'message.provider',
      'message.internal',
    ];

    it('shows Operations every request that has a readable message, newest first', async () => {
      const result = await list(ALL);
      // r9 and r8 share a last-message time; the higher number comes first.
      // r6 (declined provider) and r7 (no messages) are absent.
      const expected = ['r11', 'r10', 'r9', 'r8', 'r5', 'r4', 'r3', 'r2', 'r1'];
      expect(codes(result)).toEqual(expected.map((key) => f[key].code));
      expect(result.data.map((item) => item.lastMessage.at.getTime())).toEqual(
        [...result.data.map((item) => item.lastMessage.at.getTime())].sort(
          (a, b) => b - a,
        ),
      );
    });

    it('limits Finance and Procurement to provider and internal messages', async () => {
      {
        const result = await list(['message.provider', 'message.internal']);
        // r1 and r2 have internal notes; r3 has only customer messages; r8-r11 only customer.
        expect(codes(result).sort()).toEqual(
          [f.r1, f.r2, f.r4, f.r5].map((item) => item.code).sort(),
        );
        const r1 = result.data.find((item) => item.requestId === f.r1.code)!;
        expect(r1.lastMessage.audience).toBe('internal');
        // The customer messages before the note are not visible, so nothing waits.
        expect(r1.waitingForXpro).toBe(0);
        const r2 = result.data.find((item) => item.requestId === f.r2.code)!;
        expect(r2.lastMessage.text).toBe('Looking into it');
        expect(r2.waitingForXpro).toBe(0);
      }
    });

    it('limits a customer-only viewer to the customer channel', async () => {
      const result = await list(['message.customer']);
      expect(codes(result)).not.toContain(f.r4.code);
      expect(codes(result)).not.toContain(f.r5.code);
      const r1 = result.data.find((item) => item.requestId === f.r1.code)!;
      expect(r1.lastMessage.audience).toBe('customer');
      expect(r1.lastMessage.text).toBe('Hello?');
      expect(r1.waitingForXpro).toBe(2);
    });

    it('rejects staff with no message permission', async () => {
      await expect(list(['view.pricing'])).rejects.toMatchObject({
        constructor: AppError,
        code: 'FORBIDDEN',
      });
    });

    it('answers 403 FORBIDDEN over HTTP for non-staff and inactive staff', async () => {
      for (const user of [plainUser, suspended, ownerUser]) {
        const response = await withHeader(user.id);
        expect(response.status).toBe(403);
        expect((response.body as { error: { code: string } }).error.code).toBe(
          'FORBIDDEN',
        );
      }
    });

    it('serves the real Operations, Finance and Procurement roles over HTTP', async () => {
      const opsBody = (await withHeader(ops.id).query({ q: RUN, limit: 50 }))
        .body as ConversationList;
      const financeBody = (
        await withHeader(finance.id).query({ q: RUN, limit: 50 })
      ).body as ConversationList;
      const pricingBody = (
        await withHeader(pricing.id).query({ q: RUN, limit: 50 })
      ).body as ConversationList;
      expect(codes(opsBody)).toContain(f.r3.code);
      expect(codes(financeBody)).not.toContain(f.r3.code);
      expect(codes(pricingBody)).toEqual(codes(financeBody));
    });
  });

  describe('item contents', () => {
    it('builds the contract shape for a customer conversation', async () => {
      const response = await withHeader(ops.id).query({
        q: 'Roof replacement',
      });
      expect(response.status).toBe(200);
      const body = response.body as {
        data: Array<Record<string, unknown>>;
        meta: Record<string, unknown>;
      };
      // No { data: { data } } nesting: data is the array and meta is its sibling.
      expect(Array.isArray(body.data)).toBe(true);
      const item = body.data.find((row) => row.requestId === f.r1.code)!;
      expect(item).toMatchObject({
        requestId: f.r1.code,
        title: `${RUN} Roof replacement`,
        status: 'in_progress',
        closed: false,
        owner: { id: ops.id, name: opsName },
        customer: { name: `Chika ${RUN}` },
        provider: null,
        waitingForXpro: 0,
        lastMessage: {
          audience: 'internal',
          authorRole: 'staff',
          authorLabel: opsName,
          text: 'Customer is chasing, call them',
        },
      });
      expect(typeof item.statusLabel).toBe('string');
      expect(JSON.stringify(item)).not.toMatch(/phone|address|email/i);
      expect(body.meta).toEqual({
        nextCursor: null,
        statusCounts: expect.any(Object) as object,
      });
    });

    it('counts the customer messages after the latest staff message, ignoring notes', async () => {
      const result = await list([
        'message.customer',
        'message.provider',
        'message.internal',
      ]);
      const r2 = result.data.find((item) => item.requestId === f.r2.code)!;
      // Note at 11 is staff-authored: the two customer messages after it count.
      expect(r2.waitingForXpro).toBe(2);
      expect(r2.status).toBe('under_review');
      // Long last message is cut with an ellipsis.
      expect(r2.lastMessage.text.endsWith('…')).toBe(true);
      expect(r2.lastMessage.text.length).toBeLessThanOrEqual(141);
      expect(r2.lastMessage.authorRole).toBe('customer');
    });

    it('flags closed requests and shows the current provider', async () => {
      const result = await list(['message.provider']);
      const r4 = result.data.find((item) => item.requestId === f.r4.code)!;
      expect(r4.closed).toBe(true);
      expect(r4.status).toBe('closed');
      expect(r4.provider).toEqual({ name: `Tunde Roofing ${RUN}` });
      expect(r4.waitingForXpro).toBe(1);
    });

    it('leaves earlier providers out of the last message and the waiting count', async () => {
      const result = await list(['message.provider']);
      const r5 = result.data.find((item) => item.requestId === f.r5.code)!;
      expect(r5.provider).toEqual({ name: `Current Provider ${RUN}` });
      expect(r5.lastMessage.text).toBe('Current provider again');
      expect(r5.lastMessage.audience).toBe('provider');
      // After the staff reply at 51 only "again" at 52 is waiting; old-thread messages never count.
      expect(r5.waitingForXpro).toBe(1);
    });

    it('omits requests whose latest assignment is no longer current, and requests with no messages', async () => {
      const result = await list([
        'message.provider',
        'message.internal',
        'message.customer',
      ]);
      expect(codes(result)).not.toContain(f.r6.code);
      expect(codes(result)).not.toContain(f.r7.code);
    });
  });

  describe('filters', () => {
    it('keeps only the chosen statuses and leaves statusCounts unfiltered', async () => {
      const all = await list([
        'message.customer',
        'message.provider',
        'message.internal',
      ]);
      const filtered = await list(
        ['message.customer', 'message.provider', 'message.internal'],
        { status: ['quoted', 'closed'] },
      );
      expect(new Set(filtered.data.map((item) => item.status))).toEqual(
        new Set(['quoted', 'closed']),
      );
      expect(filtered.meta.statusCounts).toEqual(all.meta.statusCounts);
      expect(all.meta.statusCounts).toEqual({
        under_review: 1,
        quoted: 3,
        in_progress: 4,
        closed: 1,
      });
      expect(filtered.data).toHaveLength(4);
    });

    it('applies q to the counts', async () => {
      const result = await list(
        ['message.customer', 'message.provider', 'message.internal'],
        { q: `${RUN} Tie` },
      );
      expect(result.meta.statusCounts).toEqual({ quoted: 2 });
    });

    it.each([
      ['title', `${RUN} Roof`, 'r1'],
      ['description', 'corrugated ROOF sheets', 'r1'],
      ['sub-service name', `${RUN} leak repair`, 'r1'],
      ['service name', `${RUN} plumbing`, 'r1'],
      ['state name', `${RUN} lagosia`, 'r1'],
      ['LGA name', `${RUN} ikejaland`, 'r1'],
      ['area name', `${RUN} ikejaville`, 'r1'],
      ['customer name', `Chika ${RUN}`, 'r1'],
      ['provider business name', `Tunde Roofing ${RUN}`, 'r4'],
    ])('finds a request by %s, case-insensitively', async (_name, q, key) => {
      const result = await list(
        ['message.customer', 'message.provider', 'message.internal'],
        { q },
      );
      expect(codes(result)).toContain(f[key].code);
    });

    it('finds a request by public id and by its digits', async () => {
      for (const q of [
        f.r3.code,
        f.r3.code.toLowerCase(),
        String(f.r3.number),
      ]) {
        const result = await list(
          ['message.customer', 'message.provider', 'message.internal'],
          { q },
        );
        expect(codes(result)).toContain(f.r3.code);
      }
      const other = await list(
        ['message.customer', 'message.provider', 'message.internal'],
        { q: 'XPR-99999999' },
      );
      expect(codes(other)).not.toContain(f.r3.code);
    });

    it('does not search message text', async () => {
      const result = await list(
        ['message.customer', 'message.provider', 'message.internal'],
        { q: 'Thursday would be ideal' },
      );
      expect(result.data).toEqual([]);
    });

    it('matches _ and % literally', async () => {
      const result = await list(
        ['message.customer', 'message.provider', 'message.internal'],
        { q: `${RUN} Pipe_100%` },
      );
      expect(codes(result)).toEqual([f.r10.code]);
      const backslash = await list(
        ['message.customer', 'message.provider', 'message.internal'],
        { q: `${RUN}\\` },
      );
      expect(backslash.data).toEqual([]);
    });

    it('does not treat a hostile q as SQL', async () => {
      const result = await list(
        ['message.customer', 'message.provider', 'message.internal'],
        { q: "x'; DROP TABLE service_requests; --" },
      );
      expect(result.data).toEqual([]);
      expect(await prisma.serviceRequest.count()).toBeGreaterThan(0);
    });
  });

  describe('paging', () => {
    it('walks every conversation once, breaking last-message ties by request number', async () => {
      const permissions: StaffPermission[] = [
        'message.customer',
        'message.provider',
        'message.internal',
      ];
      const full = await list(permissions);
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const page = await list(permissions, { limit: 3, cursor });
        expect(page.data.length).toBeLessThanOrEqual(3);
        seen.push(...codes(page));
        cursor = page.meta.nextCursor ?? undefined;
        pages += 1;
        // Counts are independent of the page.
        expect(page.meta.statusCounts).toEqual(full.meta.statusCounts);
      } while (cursor && pages < 10);
      expect(seen).toEqual(codes(full));
      expect(new Set(seen).size).toBe(seen.length);
      expect(pages).toBe(Math.ceil(full.data.length / 3));
      // The tie pair stays ordered by number, newest first.
      expect(seen.indexOf(f.r9.code)).toBeLessThan(seen.indexOf(f.r8.code));
    });

    it('rejects a bad cursor with 422 VALIDATION_ERROR', async () => {
      const response = await withHeader(ops.id).query({ cursor: 'garbage!' });
      expect(response.status).toBe(422);
      expect((response.body as { error: { code: string } }).error.code).toBe(
        'VALIDATION_ERROR',
      );
    });

    it('rejects unknown statuses and bad limits with 422 VALIDATION_ERROR', async () => {
      for (const query of [
        'status=nope',
        'status=quoted&status=nope',
        'limit=0',
        'limit=51',
      ]) {
        const response = await request(server())
          .get(`/admin/conversations?${query}`)
          .set('x-user', ops.id);
        expect(response.status).toBe(422);
        expect((response.body as { error: { code: string } }).error.code).toBe(
          'VALIDATION_ERROR',
        );
      }
    });

    it('accepts one status value and a repeated status', async () => {
      const single = await request(server())
        .get('/admin/conversations?status=quoted&limit=50')
        .set('x-user', ops.id);
      expect(single.status).toBe(200);
      const several = await request(server())
        .get('/admin/conversations?status=quoted&status=closed&limit=50')
        .set('x-user', ops.id);
      expect(several.status).toBe(200);
      const rows = (several.body as ConversationList).data;
      expect(
        rows.every((row) => ['quoted', 'closed'].includes(row.status)),
      ).toBe(true);
    });
  });
});
