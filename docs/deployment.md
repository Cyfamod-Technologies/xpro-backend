# Deployment

## Topology

| Service | Image | Role |
| --- | --- | --- |
| `server` | Built from `./Dockerfile` | NestJS API |
| `postgres` | `postgres:16-alpine` | Primary datastore |
| `redis` | `redis:7-alpine` | Sessions + BullMQ queues |

Queue workers run **in-process** with the API. If you need to scale them
separately, run a second container from the same image with a different command
and disable processor registration on the web instance.

## Dockerfile

Two stages. `base` installs dependencies, generates the Prisma client, builds, then
prunes dev dependencies; `runner` copies `node_modules`, `dist`, `prisma` and
`package*.json` into a clean `node:22-alpine`.

`prisma/` is copied into the runner because `prisma migrate deploy` needs the
migration files at container start.

```bash
docker build -t xpro-api .
```

## Compose

```bash
# Development — infrastructure only, API on the host
docker compose --env-file .env.local up -d
npm run start:dev

# Development — everything in containers
docker compose --env-file .env.local --profile full up --build

# Production
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
```

The `server` service sits behind the `full` profile so the default `up` gives you
just Postgres and Redis, which is what you want for day-to-day work with hot reload.

The prod compose file deliberately has **no defaults** — every variable must be
present in `.env.prod`, so a missing secret fails loudly instead of silently
starting with a weak one.

## Migrations

Both compose files start the server with:

```sh
npx prisma migrate deploy && node dist/main.js
```

`migrate deploy` is non-interactive and never generates migrations — it only
applies what is committed. Never run `migrate dev` against production.

With more than one API replica, run migrations as a separate step before rolling
out rather than in each container's start command, or concurrent replicas will race.

## Environment

`validateEnv` runs at boot and refuses to start on a bad configuration. In
production it additionally requires:

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` and the email variables
- All URL variables absolute HTTPS
- `EMAIL_FROM` not on `example.com`
- `ENCRYPTION_KEY` not the shipped development default

Generate real secrets:

```bash
openssl rand -base64 48   # JWT_SECRET
openssl rand -base64 32   # ENCRYPTION_KEY (must be ≥32 chars)
```

## Health checks

`GET /health` returns `{ status: 'ok', timestamp }` without touching Postgres or
Redis — it is a liveness probe, not a readiness probe. The prod compose healthcheck
uses it.

For a readiness probe that fails when a dependency is down, extend `HealthService`
with `prisma.$queryRaw\`SELECT 1\`` and a Redis `PING`, and point your orchestrator
at that instead.

## CI

`.github/workflows/ci.yml` runs on PRs into `main` and `prod`: install, generate
the Prisma client, `npm audit --audit-level=high`, lint, test, build.

`npx prisma generate` must run before lint and build — the generated client is not
committed, and everything type-checks against it.

## Deploy

`.github/workflows/deploy.yml.example` is a starting point: SSH to a host, pull,
and `docker compose up -d --build`. To use it, rename to `deploy.yml`, set
`DEPLOY_ROOT`, and add the `SERVER_HOST`, `SERVER_USER` and `SERVER_SSH_KEY`
secrets.

It is an example rather than a default because deployment is the least portable
part of any template — replace it wholesale if you deploy to Railway, Fly, Render,
ECS or Kubernetes.

## Reverse proxy

The app sets `trust proxy` to 1, so put exactly one proxy in front of it. Client
IPs come from `X-Forwarded-For`; getting the hop count wrong means rate limiting
and audit logs record the proxy's IP instead of the client's.

Terminate TLS at the proxy. HSTS is already sent by Helmet with a one-year max-age.

## Production checklist

- [ ] `NODE_ENV=production`
- [ ] Unique `JWT_SECRET` and `ENCRYPTION_KEY`
- [ ] `CORS_ORIGINS` set to real origins
- [ ] Redis password set, not exposed publicly
- [ ] Postgres not exposed publicly (the dev compose publishes 5432 — the prod file does not)
- [ ] Swagger disabled or protected (it is public at `/` and `/docs`)
- [ ] Database backups configured
- [ ] `DISCORD_WEBHOOK_URL` or another alerting sink set
- [ ] Log aggregation in place
- [ ] Migrations run as a separate step if running multiple replicas

## Disabling Swagger in production

```ts
if (process.env.NODE_ENV !== 'production') {
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('/', app, document);
  SwaggerModule.setup('docs', app, document);
}
```

Leave the two Helmet CSP policies in place either way — the strict policy applies
to everything that is not a Swagger route.
