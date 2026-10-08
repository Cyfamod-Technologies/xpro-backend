# NestJS Prisma Postgres Template — Agent Bootstrap Guide

This file is the starting point for any agent working in this repository.
Read the relevant docs before making changes.

## Key documents

| Document                                             | When to read                                |
| ---------------------------------------------------- | ------------------------------------------- |
| [docs/setup.md](docs/setup.md)                       | Environment, deps, dev commands             |
| [docs/architecture.md](docs/architecture.md)         | Request lifecycle, modules, auth, queues    |
| [docs/folder-structure.md](docs/folder-structure.md) | Where code belongs                          |
| [docs/code-style.md](docs/code-style.md)             | TypeScript, NestJS, naming, diff scope      |
| [docs/security.md](docs/security.md)                 | Guards, roles, surfaces, sessions, secrets  |
| [docs/background-jobs.md](docs/background-jobs.md)   | BullMQ queues, processors, how to add jobs  |
| [docs/database.md](docs/database.md)                 | Prisma conventions, migrations, seeding     |
| [docs/deployment.md](docs/deployment.md)             | Docker, compose, CI/CD, production checks   |
| [docs/email/](docs/email/README.md)                  | Email rendering and provider setup          |
| [docs/storage/](docs/storage/README.md)              | Object storage setup (opt-in)               |

## What this template is

Single-tenant NestJS API: users have an application-level `AppRole` and a permitted
`AppSurface`. There is **no** organization, workspace, project or membership layer.
Do not assume tenancy exists — if a feature needs it, ask before building it.

## Working rules

### NestJS module structure

- One feature per folder under `src/<feature>/`: `*.module.ts`, `*.controller.ts`, `*.service.ts`, and `dto/` for request/response types.
- Register every new module in `src/app.module.ts`.
- Import shared infrastructure (`PrismaModule`, `JobsModule`, `RedisModule`, `StorageModule`) in the feature module — never instantiate them ad hoc.
- Controllers handle HTTP only: apply guards, validate input, delegate to the service. Business logic lives in services.
- Large services may be split into focused files in the same folder rather than using section-header comments.

### DTOs and validation

- Use `class-validator` decorators for validation and `@nestjs/swagger` decorators (`@ApiProperty`, `@ApiOperation`, `@ApiTags`) for OpenAPI documentation.
- `ValidationPipe` runs globally with `whitelist: true` and `forbidNonWhitelisted: true` — every DTO field must be declared.

### Authentication and authorization

- Authenticated routes: `@UseGuards(JwtAuthGuard)` + `@CurrentUser()`.
- Role-restricted routes: add `RolesGuard` + `@Roles('admin', 'super_admin')`.
- Surface-restricted routes: add `AppSurfaceGuard` + `@AppSurfaces(AppSurface.admin)`.
- There is no ownership guard. **Scope every query by the caller's `userId` in the service** — prefer `findFirst({ where: { id, ownerId: userId } })` over `findUnique` plus a check.
- Sessions are server-side in Redis; `JwtStrategy` re-validates the session and the user's status on every request.

### Prisma and database

- All application code accesses the database via the injected `PrismaService`.
- `Json` fields require plain serializable values (`Prisma.InputJsonValue`) — map DTO instances to plain objects before persisting.
- Standalone seed scripts under `src/scripts/` may use `PrismaClient` directly.

### Background jobs

- All async work goes through BullMQ via `JobsModule` — never call a processor directly from a controller or service.
- Use `JobsService` methods to enqueue work. All queues are defined in `jobs.constants.ts`.
- Processors extend `WorkerHost` and use the `@Processor('queue-name')` decorator.
- Record to `FailedJobsService` on the final attempt only, then rethrow.

### Email

- Send through `NotificationsService.queueEmail()`, never `EmailService` directly — the former writes the `Notification` record and applies the duplicate cooldown.
- Templates are pure functions and must not hardcode a product name; use `context.appName`.

### Error handling

- Use NestJS built-in exceptions: `BadRequestException`, `NotFoundException`, `ForbiddenException`, `UnauthorizedException`.
- Match the error type used elsewhere in the file you are editing.
- The global `ExceptionLoggingFilter` sends Discord alerts for 5xx errors when `DISCORD_WEBHOOK_URL` is set.

### Code style

- No section-divider comments (`// ─── Section ───`) and no comments that label groups of functions.
- Only add a comment when the WHY is non-obvious: a hidden constraint, a workaround, or an external requirement.
- Minimize diff scope — do not refactor or reformat unrelated code in the same change.
- JSDoc on public APIs is fine when it adds real detail; skip it when it just restates the name.

### Git commits

- AI agents committing to this repository must add a co-author trailer identifying themselves, e.g. `Co-Authored-By: <Agent Name> <noreply@anthropic.com>`.
- Place the trailer as the last line(s) of the commit message body, after a blank line.
- Keep the subject line in the imperative mood and under ~70 characters, as elsewhere in this project.

### Response shape

- The global `ResponseInterceptor` wraps every non-streaming response in `{ statusCode, message, data }`.
- Use `@SuccessResponse({ statusCode, message })` on a handler to override the defaults.
- SSE and streaming handlers write directly to `res` — the interceptor skips committed responses.

Detailed guidance for each area lives in [docs/](docs/).

### Prisma migrations and production data

- Never edit, rename, delete, or replace an existing migration under `prisma/migrations/`.
- Treat every existing migration as immutable, even if it appears unapplied locally.
- The one exception is the shipped `00000000000000_init` migration in a project that has never been deployed — see [docs/database.md](docs/database.md#migration-rules).
- For every Prisma schema change, create a new migration containing only that change.
- Assume deployed databases may contain existing production data.
- Before making a column required, verify that existing rows can satisfy the constraint.
- When adding a field that existing records cannot immediately populate, introduce it as nullable first (for example, `String?` in Prisma, with a database default of `NULL` where appropriate).
- Backfill existing records in a separate, deliberate migration or deployment step.
- Only make the field required in a later migration after confirming that no `NULL` values remain.
- Use a safe staged migration for column renames, type changes, uniqueness constraints, foreign keys, and destructive changes.
- Do not use fake placeholder defaults merely to satisfy a migration.
- Do not drop columns, tables, constraints, or data without explicit user approval.
- Review generated SQL before applying a migration and call out possible data loss, table locks, constraint failures, or deployment downtime.
