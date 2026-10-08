import type { Server } from 'http';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const request = require('supertest') as typeof import('supertest');
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { Reflector } from '@nestjs/core';

/**
 * Boots the real AppModule, so PostgreSQL and Redis must be reachable and the
 * four required environment variables must be set:
 *
 *   docker compose up -d && npm run test:e2e
 */
describe('AppModule (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalInterceptors(new ResponseInterceptor(app.get(Reflector)));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns ok inside the response envelope', async () => {
    const response = await request(app.getHttpServer() as Server)
      .get('/health')
      .expect(200);

    expect(response.body).toMatchObject({
      statusCode: 200,
      data: { status: 'ok' },
    });
    expect(
      typeof (response.body as { data: { timestamp: string } }).data.timestamp,
    ).toBe('string');
  });

  it('GET /unknown-route returns 404', () => {
    return request(app.getHttpServer() as Server)
      .get('/unknown-route')
      .expect(404);
  });

  it('rejects unauthenticated access to a protected route', () => {
    return request(app.getHttpServer() as Server)
      .get('/auth/me')
      .expect(401);
  });

  it('strips unknown properties and rejects an invalid signup payload', () => {
    return request(app.getHttpServer() as Server)
      .post('/auth/signup')
      .send({ email: 'not-an-email', notADeclaredField: true })
      .expect(400);
  });
});
