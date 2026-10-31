import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Server } from 'http';
import { truncateRequestTables } from '../../../test/integration/db';
import {
  createStaff,
  createUser,
  deleteTestUsers,
} from '../../../test/integration/users';
import { ExceptionLoggingFilter } from '../../common/filters/exception-logging.filter';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { JobsService } from '../../jobs/jobs.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { Reflector } from '@nestjs/core';
import { PlatformModule } from '../platform.module';
import { DevTimersController } from './dev-timers.controller';
import { DevToolsGuard } from './dev-tools.guard';
import { TimersService } from './timers.service';
import { LIFE_CAMP_ID } from '../locations/locations.testkit';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require('supertest') as typeof import('supertest');

async function buildApp(enabled: boolean, addTimersKickJob: jest.Mock) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      PrismaModule,
      PlatformModule,
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        validate: () => ({ ENABLE_DEV_TOOLS: enabled ? 'true' : 'false' }),
      }),
    ],
    controllers: [DevTimersController],
    providers: [
      TimersService,
      DevToolsGuard,
      { provide: JobsService, useValue: { addTimersKickJob } },
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
  const app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new ExceptionLoggingFilter());
  app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
  await app.init();
  return app;
}

describe('POST /admin/dev/timers/fire (integration)', () => {
  let prisma: PrismaService;
  let addTimersKickJob: jest.Mock;
  let enabledApp: INestApplication;
  let disabledApp: INestApplication;
  const server = (app: INestApplication) => app.getHttpServer() as Server;

  beforeAll(async () => {
    addTimersKickJob = jest.fn().mockResolvedValue({});
    enabledApp = await buildApp(true, addTimersKickJob);
    disabledApp = await buildApp(false, addTimersKickJob);
    prisma = enabledApp.get(PrismaService);
  });

  beforeEach(async () => {
    addTimersKickJob.mockClear();
    await truncateRequestTables(prisma);
  });

  afterAll(async () => {
    await deleteTestUsers(prisma);
    await enabledApp.close();
    await disabledApp.close();
  });

  let serviceRequest: { id: string; number: number };
  const ref = () => `XPR-${String(serviceRequest.number).padStart(5, '0')}`;

  beforeEach(async () => {
    const owner = await createUser(prisma);
    serviceRequest = await prisma.serviceRequest.create({
      data: {
        ownerId: owner.id,
        customerName: 'Integration customer',
        title: 'Dev timer test',
        service: 'Design',
        locationId: LIFE_CAMP_ID,
        address: '1 Test Street',
        phone: '+2348012345678',
        description: 'Integration test request for the dev timer endpoint.',
      },
    });
  });

  afterEach(async () => {
    await prisma.requestTimer.deleteMany({});
    await prisma.serviceRequest.deleteMany({
      where: { id: serviceRequest.id },
    });
  });

  const seedTimer = () =>
    prisma.requestTimer.create({
      data: {
        requestId: serviceRequest.id,
        kind: 'T1.expire',
        dueAt: new Date('2099-01-01T00:00:00Z'),
      },
    });

  it('is a 404 when dev tools are disabled, even for a super admin', async () => {
    const admin = await createStaff(prisma, ['super_admin']);
    await seedTimer();
    await request(server(disabledApp))
      .post('/admin/dev/timers/fire')
      .set('x-user', admin.id)
      .send({ requestRef: ref(), kind: 'T1.expire' })
      .expect(404);
    expect(addTimersKickJob).not.toHaveBeenCalled();
  });

  it('refuses staff without settings.manage and customers', async () => {
    const ops = await createStaff(prisma, ['operations']);
    const customer = await createUser(prisma);
    await seedTimer();
    for (const user of [ops, customer])
      await request(server(enabledApp))
        .post('/admin/dev/timers/fire')
        .set('x-user', user.id)
        .send({ requestRef: ref(), kind: 'T1.expire' })
        .expect(403);
  });

  it('makes the pending timer due now and kicks the sweeper', async () => {
    const admin = await createStaff(prisma, ['super_admin']);
    const timer = await seedTimer();
    const before = Date.now();

    const res = await request(server(enabledApp))
      .post('/admin/dev/timers/fire')
      .set('x-user', admin.id)
      .send({ requestRef: ref(), kind: 'T1.expire' })
      .expect(200);

    expect(res.body).toMatchObject({ data: { fired: 1 } });
    const row = await prisma.requestTimer.findUniqueOrThrow({
      where: { id: timer.id },
    });
    expect(row.dueAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.dueAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(addTimersKickJob).toHaveBeenCalledTimes(1);
  });

  it('accepts the request uuid as well as the XPR number', async () => {
    const admin = await createStaff(prisma, ['super_admin']);
    await seedTimer();
    const res = await request(server(enabledApp))
      .post('/admin/dev/timers/fire')
      .set('x-user', admin.id)
      .send({ requestRef: serviceRequest.id, kind: 'T1.expire' })
      .expect(200);
    expect(res.body).toMatchObject({ data: { fired: 1 } });
  });

  it('is a 404 for an unknown or malformed request reference', async () => {
    const admin = await createStaff(prisma, ['super_admin']);
    await seedTimer();
    for (const requestRef of ['XPR-99999', 'req-1'])
      await request(server(enabledApp))
        .post('/admin/dev/timers/fire')
        .set('x-user', admin.id)
        .send({ requestRef, kind: 'T1.expire' })
        .expect(404);
  });

  it('is a 404 when no pending timer matches, and validates the body', async () => {
    const admin = await createStaff(prisma, ['super_admin']);
    await request(server(enabledApp))
      .post('/admin/dev/timers/fire')
      .set('x-user', admin.id)
      .send({ requestRef: ref(), kind: 'T1.expire' })
      .expect(404);
    await request(server(enabledApp))
      .post('/admin/dev/timers/fire')
      .set('x-user', admin.id)
      .send({ requestRef: ref() })
      .expect(400);
    expect(addTimersKickJob).not.toHaveBeenCalled();
  });
});
