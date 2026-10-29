# Security

## Guards

| Guard | Applied with | Checks |
| --- | --- | --- |
| `JwtAuthGuard` | `@UseGuards(JwtAuthGuard)` | Valid JWT **and** a live Redis session **and** an `active` user |
| `RolesGuard` | `+ @Roles('admin', 'super_admin')` | `AppRole` on the token |
| `AppSurfaceGuard` | `+ @AppSurfaces(AppSurface.admin)` | Which frontend the token was issued for |
| `ThrottlerGuard` | global | 120 requests per 60s per IP |

Guards compose left to right, so put `JwtAuthGuard` first:

```ts
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin', 'super_admin')
@Get('admin/users')
listUsers() { ... }
```

Unauthenticated routes are the default — there is no global auth guard. Adding a
new route means deciding its protection explicitly.

## Sessions

Sessions live in Redis, not only in the token. `JwtStrategy.validate()` runs two
checks on every request: the session record still exists, and the user's status is
still `active`. Consequences worth knowing:

- Logout, single-session revoke and revoke-all take effect immediately.
- Deactivating or suspending a user kills their live sessions without waiting for
  token expiry.
- Redis being down means no one can authenticate. That is deliberate — failing
  closed is the right default for an auth store.

Session cookies are `httpOnly`, `secure` in production, and `sameSite: 'none'` in
production / `'lax'` in development.

## Secrets and encryption

- `ENCRYPTION_KEY` (≥32 chars) backs `encryptSecret` / `decryptSecret` in
  `src/common/utils/crypto.util.ts` — AES-256-GCM. Use it for any third-party
  credential you store.
- `validateEnv` refuses to boot in production with the shipped development key.
- `JWT_SECRET` must be unique per environment. Rotating it invalidates every token.
- Tokens are generated in `src/common/utils/token.util.ts` and stored **hashed**
  (`hashToken`) — password reset and email verification tokens are never persisted
  in plaintext.

## Passwords

bcrypt with cost factor 12. Password reset consumes a single-use hashed token from
Redis. Changing a password is a good place to call `revokeAllSessionsForUser()`.

## MFA

TOTP with a two-phase setup so an abandoned enrolment leaves no usable secret.
`mfaSecret` is stored on the user row — encrypt it with `crypto.util.ts` if your
threat model includes database-at-rest exposure.

`POST /auth/reauthenticate` issues a short-lived (5 min) re-auth token for
step-up confirmation before sensitive operations.

## HTTP hardening (`main.ts`)

- **Helmet** with two CSPs: relaxed for the Swagger route, strict everywhere else.
- **HSTS** — one year, `includeSubDomains`, `preload`.
- **CORS** restricted to `CORS_ORIGINS`. Do not change this to `origin: true`
  unless you are serving something genuinely cross-origin, and then pair it with a
  request-level check — reflecting any origin with `credentials: true` defeats the
  point of CORS.
- **`Permissions-Policy`** disables camera, microphone, geolocation, payment, USB.
- **No-store cache headers** on `/api/*`.
- **Referrer-Policy**: `no-referrer`.

Swagger UI is served at `/` and is **public**. Put it behind auth or disable it in
production if your API is not meant to be self-documenting.

## Input validation

The global `ValidationPipe` runs with `whitelist: true` and
`forbidNonWhitelisted: true`: undeclared properties are stripped and rejected. Every
DTO field therefore needs an explicit `class-validator` decorator, or it will not
reach your service.

## Authorization is your job

The template has no tenancy model. Nothing stops user A from requesting user B's
resource by id unless you scope the query:

```ts
// Wrong
return this.prisma.widget.findUnique({ where: { id } });

// Correct
return this.prisma.widget.findFirst({ where: { id, ownerId: userId } });
```

Prefer `findFirst` with an ownership predicate over `findUnique` followed by an
`if` — it cannot be forgotten, and it returns `null` rather than leaking existence.

## Audit logging

`AuditLogsService.record()` on anything security-relevant: signup, login, password
change, MFA enrolment, role change, deletion. Entries capture actor, entity, action
and IP (from `RequestContextService`).

## Before going to production

- [ ] Unique `JWT_SECRET` and `ENCRYPTION_KEY`
- [ ] `CORS_ORIGINS` set to real origins
- [ ] `NODE_ENV=production` (enables the stricter `validateEnv` branch)
- [ ] Swagger disabled or protected
- [ ] Redis password set and not reachable from the public internet
- [ ] `DISCORD_WEBHOOK_URL` or another alerting sink configured
- [ ] `npm audit --audit-level=high` clean (CI enforces this)
