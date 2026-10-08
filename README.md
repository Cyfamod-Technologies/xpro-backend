# NestJS Prisma Postgres Template

A production-shaped NestJS 11 API template: PostgreSQL via Prisma, Redis-backed
sessions and BullMQ queues, JWT auth with TOTP MFA, transactional email, audit
logging and opt-in object storage.

Boots on four environment variables. Everything else is optional or has a default.

## Quick start

```bash
npm install --legacy-peer-deps
cp .env.example .env
docker compose up -d          # postgres + redis
npx prisma migrate deploy
npm run generate
npm run start:dev
```

API docs at `http://127.0.0.1:4000/` and `http://127.0.0.1:4000/docs`.

Then rename everything for your project:

```bash
npm run init
```

## What's included

| Area | Detail |
| --- | --- |
| **Auth** | Signup, email verification (6-digit OTP), login, password reset, change password |
| **Sessions** | Server-side in Redis — logout, per-session revoke and revoke-all take effect immediately |
| **MFA** | TOTP with two-phase enrolment, no external dependency |
| **Authorization** | `AppRole` (`super_admin` / `admin` / `user`) and `AppSurface` (`admin` / `user`) guards |
| **Database** | Prisma 6 + PostgreSQL 16, snake_case mapping, one init migration |
| **Queues** | BullMQ with retry/backoff defaults and a `FailedJob` dead-letter table |
| **Email** | Template renderer split from transport, 4 templates, queued sends with delivery records |
| **Audit log** | Fire-and-forget, written off the request path |
| **Storage** | Cloudflare R2, opt-in and inert by default |
| **HTTP hardening** | Helmet with split CSP, CORS allowlist, rate limiting, Permissions-Policy |
| **Ops** | `GET /health`, structured logging, optional Discord alerting on 5xx |
| **DX** | Swagger, global response envelope, ESLint + Prettier, Jest, Docker Compose, CI workflow |

## What this is not

Deliberately **single-tenant**. There is no organization, workspace, project or
membership model, and no per-resource permission matrix. Users are global, with a
role and a permitted frontend surface.

That means **resource ownership is your responsibility**. Nothing stops user A
from fetching user B's record by id unless you scope the query:

```ts
// Wrong
return this.prisma.widget.findUnique({ where: { id } });

// Correct
return this.prisma.widget.findFirst({ where: { id, ownerId: userId } });
```

If you need multi-tenancy, add it deliberately rather than bolting it onto the
auth layer — see [docs/security.md](docs/security.md#authorization-is-your-job).

## Configuration

Required to boot:

```bash
DATABASE_URL=postgresql://app:app@localhost:5432/app_db?schema=public
JWT_SECRET=...
REDIS_HOST=127.0.0.1
ENCRYPTION_KEY=...          # ≥32 chars
```

Optional subsystems stay dormant until configured: object storage
(`STORAGE_DRIVER=none`) and email sending (rendering and previews work without a
provider token). See [`.env.example`](.env.example) for the annotated list.

`validateEnv` runs at boot and fails fast on a bad configuration, with extra
requirements under `NODE_ENV=production`.

## Adding a feature

```
src/widgets/
├── dto/widgets.dto.ts
├── widgets.controller.ts
├── widgets.module.ts
└── widgets.service.ts
```

Register the module in `src/app.module.ts`. Controllers do HTTP only; services own
the logic. See [docs/code-style.md](docs/code-style.md).

## Commands

| Command | Purpose |
| --- | --- |
| `npm run init` | One-time rename of the template |
| `npm run start:dev` | Watch-mode dev server |
| `npm run build` / `start:prod` | Compile and run |
| `npm run lint` | ESLint with `--fix` |
| `npm test` / `test:e2e` / `test:cov` | Tests |
| `npm run migrate` / `generate` / `studio` | Prisma |
| `npm run seed:super-admin` / `seed:sample-user` | Seed users |
| `npm run email:preview` | Render email templates to `.email-previews/` |

## Documentation

Start with [docs/architecture.md](docs/architecture.md), or
[docs/setup.md](docs/setup.md) to get running. Provider setup lives in
[docs/email/](docs/email/README.md) and [docs/storage/](docs/storage/README.md).

[AGENTS.md](AGENTS.md) is the entry point for coding agents.

## Stack

NestJS 11 · TypeScript 5 · Prisma 6 · PostgreSQL 16 · Redis 7 · BullMQ · Passport
JWT · class-validator · Swagger · Jest · Docker
