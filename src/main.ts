import { ValidationPipe } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as bodyParser from 'body-parser';
import { Express, NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ExceptionLoggingFilter } from './common/filters/exception-logging.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

const defaultCorsOrigins = ['http://localhost:3000', 'http://localhost:5173'];

function getCorsOrigins() {
  return (
    process.env.CORS_ORIGINS?.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean) ?? defaultCorsOrigins
  );
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const corsOrigins = getCorsOrigins();

  const serviceName = process.env.SERVICE || 'Xpro API';

  const swaggerConfig = new DocumentBuilder()
    .setTitle(serviceName)
    .setDescription(`${serviceName} — HTTP API reference`)
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'Authorization',
        description: 'Enter JWT token',
        in: 'header',
      },
      // Name must match the default used by @ApiBearerAuth() on controllers
      'bearer',
    )
    .addSecurityRequirements('bearer')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  // Served at both the root and /docs. The root is convenient when the API has
  // its own hostname; /docs is the stable path to link to and survives mounting
  // something else at `/` later.
  SwaggerModule.setup('/', app, document);
  SwaggerModule.setup('docs', app, document);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Restricted to the CORS_ORIGINS allowlist. Only widen this if you serve
  // something embedded on third-party domains, and pair it with a
  // request-level check — `origin: true` reflects any caller's origin.
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'X-Requested-With',
      'Origin',
      'X-XPro-Client',
      'X-XPro-Device-Id',
      'X-XPro-App-Version',
      'X-XPro-Activity',
      'Idempotency-Key',
      'If-Match',
      'X-CSRF-Token',
    ],
    exposedHeaders: [
      'Content-Range',
      'X-Content-Range',
      'Content-Type',
      'ETag',
      'Retry-After',
      'X-XPro-Perm-Version',
    ],
  });

  (app.getHttpAdapter().getInstance() as Express).set('trust proxy', 1);

  app.useGlobalFilters(new ExceptionLoggingFilter());

  const reflector = app.get(Reflector);
  app.useGlobalInterceptors(new ResponseInterceptor(reflector));

  app.use(bodyParser.json({
    limit: process.env.JSON_BODY_LIMIT || '10mb',
    verify: (request, _response, buffer) => {
      if (request.url?.split('?')[0] === '/webhooks/paystack')
        (request as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    },
  }));
  app.use(
    bodyParser.urlencoded({
      limit: process.env.URLENCODED_BODY_LIMIT || '10mb',
      extended: true,
    }),
  );

  const sharedCspDirectives = {
    defaultSrc: ["'self'"],
    imgSrc: ["'self'", 'data:', 'https:'],
    fontSrc: ["'self'", 'https:', 'data:'],
    connectSrc: ["'self'", ...corsOrigins],
    frameSrc: ["'none'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'self'"],
    upgradeInsecureRequests: [] as string[],
  };

  const sharedHelmetOptions = {
    crossOriginEmbedderPolicy: false,
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' as const },
    crossOriginResourcePolicy: { policy: 'cross-origin' as const },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    permittedCrossDomainPolicies: false,
    referrerPolicy: { policy: 'no-referrer' as const },
    xssFilter: false,
  };

  const swaggerHelmet = helmet({
    ...sharedHelmetOptions,
    contentSecurityPolicy: {
      directives: {
        ...sharedCspDirectives,
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
      },
    },
  });

  const strictHelmet = helmet({
    ...sharedHelmetOptions,
    contentSecurityPolicy: {
      directives: {
        ...sharedCspDirectives,
        styleSrc: ["'self'"],
        scriptSrc: ["'self'"],
      },
    },
  });

  // Swagger UI is served at the root route and pulls in inline scripts/styles
  // plus static assets, so it needs the relaxed CSP. Everything else stays on
  // the strict policy.
  const isSwaggerRequest = (path: string): boolean =>
    path === '/' ||
    path === '/docs' ||
    path.startsWith('/docs/') ||
    path.startsWith('/swagger-ui') ||
    path.startsWith('/favicon') ||
    path === '/-json' ||
    path === '/-yaml' ||
    path === '/docs-json' ||
    path === '/docs-yaml';

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (isSwaggerRequest(req.path)) {
      swaggerHelmet(req, res, next);
    } else {
      strictHelmet(req, res, next);
    }
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), screen-wake-lock=()',
    );

    if (req.path !== '/health' && !isSwaggerRequest(req.path)) {
      res.setHeader(
        'Cache-Control',
        'no-store, no-cache, must-revalidate, private',
      );
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }

    next();
  });

  (app.getHttpServer() as { setTimeout(ms: number): void }).setTimeout(60_000);

  const port = process.env.PORT || 4000;
  await app.listen(port);
  console.log(`${serviceName} running on http://127.0.0.1:${port}`);
}

void bootstrap();
