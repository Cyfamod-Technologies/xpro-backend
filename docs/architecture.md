# Architecture

A NestJS 11 HTTP API on PostgreSQL (Prisma) and Redis (sessions + BullMQ queues).
Single-tenant: users are global, with an application-level role and a permitted
frontend surface. There is no organization or workspace layer — see the
[README](../README.md#what-this-is-not) if you need multi-tenancy.

## Bootstrap (`src/main.ts`)

In order:

1. **Swagger** at `/`, titled from `SERVICE`, with a bearer auth scheme named `bearer`.
2. **Global `ValidationPipe`** — `whitelist`, `forbidNonWhitelisted`, `transform`.
3. **CORS** — restricted to the `CORS_ORIGINS` allowlist, credentials enabled.
4. **`trust proxy`** so client IPs survive a reverse proxy.
5. **Global `ExceptionLoggingFilter`** — consistent error shape and logging.
6. **Global `ResponseInterceptor`** — `{ statusCode, message, data }` envelope.
7. **Body parsers** — limits from `JSON_BODY_LIMIT` / `URLENCODED_BODY_LIMIT`.
8. **Helmet** — two policies: a relaxed CSP for the Swagger route (it needs inline
   scripts and styles) and a strict CSP for everything else.
9. **Cache and Permissions-Policy headers**, then a 60s server timeout.

## Root module (`src/app.module.ts`)

| Import | Role |
| --- | --- |
| `RequestContextModule` | AsyncLocalStorage carrying the request IP |
| `ConfigModule` | Global, validated by `validateEnv` |
| `PrismaModule` | Global `PrismaService` |
| `ThrottlerModule` | 120 requests / 60s, enforced by a global `ThrottlerGuard` |
| `BullModule.forRootAsync` | Redis connection + default retry/retention policy |
| `RedisModule` | `REDIS_CLIENT` token and `SessionStore` |
| `AuthModule` | Signup, login, MFA, sessions |
| `UsersModule` | Generic user helpers |
| `AuditLogsModule` | Async audit trail |
| `NotificationsModule` | Notification records + email dispatch |
| `JobsModule` | Queue producers and processors |
| `HealthModule` | `GET /health` |

`StorageModule` is deliberately **not** imported — it is opt-in. See
[storage/](storage/README.md).

## Request lifecycle

```
Request
  → ThrottlerGuard (global rate limit)
  → RequestContextMiddleware (captures IP into AsyncLocalStorage)
  → Route guards (JwtAuthGuard → RolesGuard → AppSurfaceGuard)
  → ValidationPipe (DTO validation + transform)
  → Controller → Service → Prisma / Redis / BullMQ
  → ResponseInterceptor (envelope)
  → ExceptionLoggingFilter (on throw)
```

## Authentication

JWT issued by `RedisAuthService`, carried either as a bearer token or in the
`app_session` cookie (name lives in `src/auth/auth.constants.ts`).

The token payload is deliberately small:

```ts
{ sub, email, role, surfaces, sid }
```

**Sessions are server-side.** Every token is paired with a Redis session record
keyed by role, user and session id. On each request `JwtStrategy.validate()`
checks the Redis session *and* re-reads the user's status from Postgres, so a
revoked session or a deactivated account is rejected immediately rather than
waiting for token expiry. That is what makes `POST /auth/logout`,
`DELETE /auth/me/sessions/:id` and "revoke all sessions" real rather than advisory.

Session lifetime comes from `SESSION_DURATION_MINUTES`, falling back to the
`RedisAuthService` default.

Redis also holds short-lived auth material, each under its own key namespace:
email verification codes, password reset tokens, pending MFA secrets, and
re-authentication tokens.

### MFA

TOTP, implemented in `src/auth/totp.util.ts` with no external dependency.
Setup is two-phase: `POST /auth/mfa/setup` stores a *pending* secret in Redis and
returns an otpauth URL; `POST /auth/mfa/confirm` verifies a code against it before
persisting `mfaSecret` to the user. A failed setup therefore leaves no usable
secret behind.

## Authorization

Two orthogonal checks, both derived from the JWT:

- **`RolesGuard`** + `@Roles('admin', 'super_admin')` — application role (`AppRole`).
- **`AppSurfaceGuard`** + `@AppSurfaces(AppSurface.admin)` — which frontend the token
  was issued for. `AuthService.surfacesForRole()` maps roles to surfaces, so an
  end-user token cannot be replayed against admin-only routes.

Because there is no tenancy layer, resource ownership is your responsibility:
scope queries by `userId` in the service.

## Background jobs

Two queues — `email` and `audit-logs` — declared in `jobs.constants.ts`.
Producers go through `JobsService`; consumers are `WorkerHost` processors
registered in `JobsModule`. Jobs that exhaust their retries are persisted to
`FailedJob` by `FailedJobsService` so nothing is silently lost.

See [background-jobs.md](background-jobs.md).

## Email

Two layers, deliberately separate:

- **`EmailRendererService`** turns a template key plus an untyped payload into
  subject/html/text. Pure, synchronous, no I/O — which is why it is unit-testable
  and why `npm run email:preview` works without credentials.
- **`EmailService`** is the transport (ZeptoMail by default).

Nothing sends inline: `NotificationsService.queueEmail()` writes a `Notification`
row, optionally applies a Redis cooldown to suppress duplicates, and enqueues an
`email` job. The processor updates the row to `sent` or `failed`.

See [email/](email/README.md).

## Audit logging

`AuditLogsService.record()` is fire-and-forget — it enqueues rather than writing,
so request latency never depends on the audit write. The processor enriches the
entry with actor context and assigns a human-readable `publicId` (`AUD-YYMMDD-HHMMSS`).

## Error handling

`ExceptionLoggingFilter` catches everything, logs with request context, and
returns a consistent shape. When `DISCORD_WEBHOOK_URL` is set, 500s are also
pushed to Discord via `src/common/utils/discord-alert.ts`.
