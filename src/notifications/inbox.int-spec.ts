import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Server } from 'http';
import { truncateRequestTables } from '../../test/integration/db';
import { createUser, deleteTestUsers } from '../../test/integration/users';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { ResponseInterceptor } from '../common/interceptors/response.interceptor';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { InboxController } from './inbox.controller';
import { InboxService } from './inbox.service';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require('supertest') as typeof import('supertest');

type Envelope<T> = { data: T };
type ListBody = {
  items: Array<{ id: string; title: string; readAt: string | null }>;
  meta: { unread: number; total: number; page: number };
};

describe('inbox (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let inbox: InboxService;
  const server = () => app.getHttpServer() as Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      controllers: [InboxController],
      providers: [InboxService],
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
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
    await app.init();
    prisma = app.get(PrismaService);
    inbox = app.get(InboxService);
  });

  afterAll(async () => {
    await deleteTestUsers(prisma);
    await app.close();
  });

  beforeEach(async () => {
    await truncateRequestTables(prisma);
  });

  async function seed(
    recipientId: string,
    count: number,
    event = 'request.received',
  ) {
    const rows = Array.from({ length: count }, (_, i) => ({
      recipientId,
      event: `${event}.${i}`,
      title: `Title ${i}`,
      message: `Message ${i}`,
    }));
    await prisma.$transaction((tx) => inbox.createMany(tx, rows));
  }

  it('createMany writes rows and drops duplicate recipient+event pairs', async () => {
    const user = await createUser(prisma);
    const count = await prisma.$transaction((tx) =>
      inbox.createMany(tx, [
        { recipientId: user.id, event: 'a', title: 't', message: 'm' },
        { recipientId: user.id, event: 'a', title: 't', message: 'm' },
        {
          recipientId: user.id,
          event: 'b',
          title: 't',
          message: 'm',
          mandatory: true,
          requestId: 'req-1',
          link: '/requests',
        },
      ]),
    );
    expect(count).toBe(2);
    const stored = await prisma.inAppNotification.findFirstOrThrow({
      where: { event: 'b' },
    });
    expect(stored).toMatchObject({
      mandatory: true,
      requestId: 'req-1',
      link: '/requests',
      readAt: null,
    });
  });

  it('createMany rolls back with the surrounding transaction', async () => {
    const user = await createUser(prisma);
    await expect(
      prisma.$transaction(async (tx) => {
        await inbox.createMany(tx, [
          { recipientId: user.id, event: 'a', title: 't', message: 'm' },
        ]);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    expect(await prisma.inAppNotification.count()).toBe(0);
  });

  it('paginates newest first and reports unread and total in meta', async () => {
    const user = await createUser(prisma);
    await seed(user.id, 5);

    const first = await request(server())
      .get('/notifications?page=1&itemsPerPage=2')
      .set('x-user', user.id)
      .expect(200);
    const firstBody = (first.body as Envelope<ListBody>).data;
    expect(firstBody.items).toHaveLength(2);
    expect(firstBody.meta).toEqual({ unread: 5, total: 5, page: 1 });

    const last = await request(server())
      .get('/notifications?page=3&itemsPerPage=2')
      .set('x-user', user.id)
      .expect(200);
    const lastBody = (last.body as Envelope<ListBody>).data;
    expect(lastBody.items).toHaveLength(1);
    expect(lastBody.meta.page).toBe(3);
  });

  it('filters to unread and only returns the caller’s rows', async () => {
    const user = await createUser(prisma);
    const other = await createUser(prisma);
    await seed(user.id, 3);
    await seed(other.id, 2);
    const one = await prisma.inAppNotification.findFirstOrThrow({
      where: { recipientId: user.id },
    });
    await prisma.inAppNotification.update({
      where: { id: one.id },
      data: { readAt: new Date() },
    });

    const all = await request(server())
      .get('/notifications')
      .set('x-user', user.id)
      .expect(200);
    expect((all.body as Envelope<ListBody>).data.meta).toEqual({
      unread: 2,
      total: 3,
      page: 1,
    });

    const unread = await request(server())
      .get('/notifications?unread=true')
      .set('x-user', user.id)
      .expect(200);
    const body = (unread.body as Envelope<ListBody>).data;
    expect(body.items).toHaveLength(2);
    expect(body.items.every((item) => item.readAt === null)).toBe(true);
    expect(body.meta).toEqual({ unread: 2, total: 2, page: 1 });
  });

  it('marks one notification read, only for its owner', async () => {
    const user = await createUser(prisma);
    const other = await createUser(prisma);
    await seed(user.id, 2);
    const target = await prisma.inAppNotification.findFirstOrThrow({
      where: { recipientId: user.id },
    });

    const foreign = await request(server())
      .post('/notifications/read')
      .set('x-user', other.id)
      .send({ notificationId: target.id })
      .expect(200);
    expect((foreign.body as Envelope<{ updated: number }>).data.updated).toBe(
      0,
    );

    const own = await request(server())
      .post('/notifications/read')
      .set('x-user', user.id)
      .send({ notificationId: target.id })
      .expect(200);
    expect((own.body as Envelope<{ updated: number }>).data.updated).toBe(1);
    expect(
      await prisma.inAppNotification.count({
        where: { recipientId: user.id, readAt: null },
      }),
    ).toBe(1);
  });

  it('marks everything read when no id is sent and leaves other users alone', async () => {
    const user = await createUser(prisma);
    const other = await createUser(prisma);
    await seed(user.id, 3);
    await seed(other.id, 2);

    const res = await request(server())
      .post('/notifications/read')
      .set('x-user', user.id)
      .send({})
      .expect(200);
    expect((res.body as Envelope<{ updated: number }>).data.updated).toBe(3);
    expect(
      await prisma.inAppNotification.count({
        where: { recipientId: other.id, readAt: null },
      }),
    ).toBe(2);
  });

  it('rejects unknown body fields and malformed ids', async () => {
    const user = await createUser(prisma);
    await request(server())
      .post('/notifications/read')
      .set('x-user', user.id)
      .send({ notificationId: 'not-a-uuid' })
      .expect(400);
    await request(server())
      .post('/notifications/read')
      .set('x-user', user.id)
      .send({ other: 1 })
      .expect(400);
  });
});
