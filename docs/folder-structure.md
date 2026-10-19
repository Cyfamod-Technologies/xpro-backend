# Folder Structure

```
xpro-server/
├── prisma/
│   ├── schema.prisma           # Single schema file — all models here
│   └── migrations/             # Applied migration directories (never edit)
├── scripts/
│   └── init-template.ts        # One-time rename (npm run init), delete after use
├── src/
│   ├── main.ts                 # Bootstrap: Helmet, CORS, pipes, Swagger
│   ├── app.module.ts           # Root module: imports all feature modules
│   ├── audit-logs/             # Async audit log recording via BullMQ
│   ├── auth/                   # JWT auth, TOTP MFA, Redis sessions
│   │   ├── dto/
│   │   ├── auth.constants.ts   # SESSION_COOKIE_NAME
│   │   ├── auth.controller.ts
│   │   ├── auth.module.ts
│   │   ├── auth.service.ts
│   │   ├── jwt.strategy.ts     # Bearer + cookie extraction, session check
│   │   ├── redis-auth.service.ts   # Token issue/refresh/revoke, OTP storage
│   │   └── totp.util.ts        # TOTP secret generation and verification
│   ├── common/
│   │   ├── decorators/
│   │   │   ├── app-surface.decorator.ts   # @AppSurfaces()
│   │   │   ├── current-user.decorator.ts  # @CurrentUser()
│   │   │   ├── response.decorator.ts      # @SuccessResponse()
│   │   │   └── roles.decorator.ts         # @Roles()
│   │   ├── dto/
│   │   │   └── pagination.dto.ts
│   │   ├── filters/
│   │   │   └── exception-logging.filter.ts  # Global exception handler
│   │   ├── guards/
│   │   │   ├── app-surface.guard.ts
│   │   │   ├── jwt-auth.guard.ts
│   │   │   └── roles.guard.ts
│   │   ├── interceptors/
│   │   │   └── response.interceptor.ts    # Global JSON envelope
│   │   ├── request-context/    # AsyncLocalStorage IP tracking
│   │   ├── types/
│   │   │   └── request-user.ts
│   │   └── utils/
│   │       ├── crypto.util.ts      # encryptSecret / decryptSecret
│   │       ├── discord-alert.ts    # Optional 500-error alerting
│   │       ├── paginate.ts         # paginationArgs / toPaginatedResult
│   │       └── token.util.ts       # OTP and raw token generation
│   ├── config/
│   │   └── env.validation.ts   # Validates required env vars at startup
│   ├── email/                  # Provider transport + HTML/text templates
│   │   ├── email.service.ts        # SMTP transport
│   │   ├── email-renderer.service.ts   # Template key → rendered email
│   │   ├── email.types.ts          # Template keys and payload types
│   │   └── templates/
│   ├── health/                 # GET /health
│   ├── jobs/
│   │   ├── jobs.constants.ts   # QUEUE_NAMES list
│   │   ├── jobs.module.ts      # Registers queues and processors
│   │   ├── jobs.service.ts     # Producer methods (addEmailJob, addAuditLogJob)
│   │   ├── failed-jobs.service.ts  # Persists and retries failed jobs
│   │   └── processors/
│   │       ├── audit-logs.processor.ts
│   │       └── email.processor.ts
│   ├── notifications/          # Notification record + email job dispatch
│   ├── prisma/                 # PrismaService + PrismaModule (global)
│   ├── redis/                  # RedisModule (REDIS_CLIENT token) + SessionStore
│   ├── scripts/
│   │   ├── seed-super-admin.ts
│   │   ├── seed-sample-user.ts
│   │   └── render-email-previews.ts
│   ├── storage/                # Opt-in S3/R2 object storage
│   └── users/                  # Generic user helpers (UsersService)
├── test/                       # End-to-end tests
└── docs/                       # Developer documentation (this folder)
```

## Where new code belongs

| What you are adding | Where |
| --- | --- |
| New domain feature | `src/<feature>/` with module, controller, service, `dto/` |
| Shared guard | `src/common/guards/` |
| Shared decorator | `src/common/decorators/` |
| Utility function | `src/common/utils/` |
| New BullMQ queue | Add to `QUEUE_NAMES` in `jobs.constants.ts`, register in `jobs.module.ts`, add a producer method to `jobs.service.ts` |
| New processor | `src/jobs/processors/`, register in `jobs.module.ts` |
| New email template | `src/email/templates/`, plus a key and payload type in `email.types.ts` and a case in `email-renderer.service.ts` |
| Database seed script | `src/scripts/` (may use `PrismaClient` directly) |
| Prisma model changes | `prisma/schema.prisma`, then run `npm run migrate` |

## Feature module shape

One folder per feature, registered in `src/app.module.ts`:

```
src/widgets/
├── dto/
│   └── widgets.dto.ts
├── widgets.controller.ts
├── widgets.module.ts
└── widgets.service.ts
```

Large services may be split into several focused files in the same folder
(`widgets.service.ts`, `widgets-import.service.ts`) rather than growing one file
with section-header comments.
