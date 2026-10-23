import {
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  INestApplication,
  Injectable,
  Post,
  Put,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { Server } from 'http';
import { ExceptionLoggingFilter } from '../../common/filters/exception-logging.filter';
import { ResponseInterceptor } from '../../common/interceptors/response.interceptor';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { truncateRequestTables } from '../../../test/integration/db';
import { AppError } from '../errors/app-error';
import { IfMatch } from '../concurrency/if-match.decorator';
import { PlatformModule } from '../platform.module';
import { IdempotencyKey } from './idempotency-key.decorator';
import { Idempotent } from './idempotency.interceptor';
import { IdempotencyService } from './idempotency.service';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require('supertest') as typeof import('supertest');

@Injectable()
class FakeAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string>;
      user?: { id: string };
    }>();
    req.user = { id: req.headers['x-actor'] ?? 'actor-a' };
    return true;
  }
}

let executions = 0;

@Controller('widgets')
@UseGuards(FakeAuthGuard)
class WidgetsController {
  @Post()
  @Idempotent({ required: true })
  create(@Body() body: { name: string }) {
    executions += 1;
    return { id: `w-${executions}`, name: body.name };
  }

  @Post('flaky')
  @Idempotent()
  flaky() {
    executions += 1;
    if (executions === 1) {
      throw new AppError(409, 'STATE_CONFLICT', 'Not now.', { current: {} });
    }
    return { ok: true };
  }

  @Put('versioned')
  versioned(
    @IfMatch({ required: true }) version: number | undefined,
    @IdempotencyKey() key: string | undefined,
  ) {
    return { version, key };
  }
}

describe('idempotency (integration)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let service: IdempotencyService;
  const server = () => app.getHttpServer() as Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, PlatformModule],
      controllers: [WidgetsController],
      providers: [FakeAuthGuard],
    }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
    );
    app.useGlobalFilters(new ExceptionLoggingFilter());
    app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
    await app.init();
    prisma = app.get(PrismaService);
    service = app.get(IdempotencyService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    executions = 0;
    await truncateRequestTables(prisma);
  });

  it('replays the stored response for the same key and body', async () => {
    const first = await request(server())
      .post('/widgets')
      .set('Idempotency-Key', 'key-12345678')
      .send({ name: 'a' })
      .expect(201);
    const second = await request(server())
      .post('/widgets')
      .set('Idempotency-Key', 'key-12345678')
      .send({ name: 'a' })
      .expect(201);
    expect(second.body).toEqual(first.body);
    expect(executions).toBe(1);
    expect(await prisma.idempotencyKey.count()).toBe(1);
  });

  it('rejects the same key with a different body as IDEMPOTENCY_KEY_REUSED', async () => {
    await request(server())
      .post('/widgets')
      .set('Idempotency-Key', 'key-12345678')
      .send({ name: 'a' })
      .expect(201);
    const res = await request(server())
      .post('/widgets')
      .set('Idempotency-Key', 'key-12345678')
      .send({ name: 'b' })
      .expect(422);
    expect((res.body as { error: { code: string } }).error.code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    expect(executions).toBe(1);
  });

  it('scopes keys per actor', async () => {
    await request(server())
      .post('/widgets')
      .set('X-Actor', 'actor-a')
      .set('Idempotency-Key', 'key-12345678')
      .send({ name: 'a' })
      .expect(201);
    await request(server())
      .post('/widgets')
      .set('X-Actor', 'actor-b')
      .set('Idempotency-Key', 'key-12345678')
      .send({ name: 'b' })
      .expect(201);
    expect(executions).toBe(2);
  });

  it('requires the header on a required route', async () => {
    const res = await request(server())
      .post('/widgets')
      .send({ name: 'a' })
      .expect(422);
    expect(res.body).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Idempotency-Key header is required.',
      },
    });
  });

  it('does not store non-2xx responses', async () => {
    await request(server())
      .post('/widgets/flaky')
      .set('Idempotency-Key', 'key-12345678')
      .send({})
      .expect(409);
    expect(await prisma.idempotencyKey.count()).toBe(0);
    await request(server())
      .post('/widgets/flaky')
      .set('Idempotency-Key', 'key-12345678')
      .send({})
      .expect(201);
    expect(executions).toBe(2);
  });

  it('parses If-Match and Idempotency-Key params', async () => {
    const res = await request(server())
      .put('/widgets/versioned')
      .set('If-Match', 'W/"4"')
      .set('Idempotency-Key', 'key-12345678')
      .expect(200);
    expect((res.body as { data: unknown }).data).toEqual({
      version: 4,
      key: 'key-12345678',
    });
    const missing = await request(server())
      .put('/widgets/versioned')
      .expect(422);
    expect((missing.body as { error: { message: string } }).error.message).toBe(
      'Refresh the request and try again.',
    );
  });

  it('store and lookup honour a transaction client', async () => {
    const hash = service.hashRequest('POST', '/x', { a: 1 });
    await expect(
      prisma.$transaction(async (tx) => {
        await service.store(
          'actor-a',
          'key-12345678',
          hash,
          200,
          { ok: 1 },
          tx,
        );
        expect(
          await service.lookup('actor-a', 'key-12345678', hash, tx),
        ).toEqual({ status: 200, body: { ok: 1 } });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await service.lookup('actor-a', 'key-12345678', hash)).toBeNull();
  });

  it('ignores expired rows and deletes them on cleanup', async () => {
    const hash = service.hashRequest('POST', '/x', {});
    await prisma.idempotencyKey.create({
      data: {
        actorId: 'actor-a',
        key: 'key-12345678',
        requestHash: 'stale',
        status: 200,
        response: {},
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    expect(await service.lookup('actor-a', 'key-12345678', hash)).toBeNull();
    await service.store('actor-a', 'key-12345678', hash, 200, { fresh: true });
    expect(await service.lookup('actor-a', 'key-12345678', hash)).toEqual({
      status: 200,
      body: { fresh: true },
    });
    await prisma.idempotencyKey.updateMany({
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await service.deleteExpired()).toBe(1);
  });
});
