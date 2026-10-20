# Setup

## Prerequisites

- Node.js 22+
- Docker (for PostgreSQL and Redis)
- npm

## First run

```bash
npm install --legacy-peer-deps
cp .env.example .env.local
docker compose --env-file .env.local up -d  # postgres + redis
npx prisma migrate deploy     # apply the init migration
npm run generate              # generate the Prisma client
npm run start:dev
```

The API listens on `http://127.0.0.1:4000` and serves Swagger UI at `/`.

Only four variables must be set for the app to boot: `DATABASE_URL`, `JWT_SECRET`,
`REDIS_HOST` and `ENCRYPTION_KEY`. Everything else has a working default or belongs
to an optional subsystem. See [`.env.example`](../.env.example) for the annotated list.

## Renaming the template

```bash
npm run init
```

Prompts for a project name, database name and session cookie name, then rewrites
`package.json`, `.env.example`, both compose files, `APP_NAME`/`SERVICE`, the
session cookie constant and this documentation's headers. Run it once, right
after cloning, then delete `scripts/init-template.ts`.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run start:dev` | Watch-mode dev server |
| `npm run start:debug` | Watch mode with the inspector attached |
| `npm run build` | Compile to `dist/` |
| `npm run start:prod` | Run the compiled build |
| `npm run lint` | ESLint with `--fix` |
| `npm test` | Unit tests (`*.spec.ts` under `src/`) |
| `npm run test:e2e` | End-to-end tests in `test/` |
| `npm run test:cov` | Coverage report |
| `npm run generate` | `prisma generate` |
| `npm run migrate` | `prisma migrate dev` |
| `npm run studio` | Prisma Studio |
| `npm run seed:super-admin` | Create/update a `super_admin` user |
| `npm run seed:sample-user` | Create/update an ordinary verified user |
| `npm run email:preview` | Render every email template to `.email-previews/` |

The app reads `.env.local` in development and `.env.prod` when
`NODE_ENV=production`. Helper scripts use `.env.local` by default; set
`DOTENV_CONFIG_PATH=.env.prod` to run one with production settings.

## Seeding

Both seed scripts are idempotent upserts, safe to re-run.

```bash
npm run seed:super-admin -- --email admin@example.com --password 'Str0ng!Pass'
npm run seed:sample-user -- --email demo@example.com --password 'Str0ng!Pass'
```

Flags are optional — each falls back to environment variables
(`SUPER_ADMIN_*`, `SAMPLE_USER_*`), and the super-admin script prompts
interactively for anything still missing.

The sample user is created already `active` with `emailVerifiedAt` set, so you can
log in without going through signup and email verification.

## Email previews

```bash
npm run email:preview            # all templates
npm run email:preview welcome    # one template
```

Writes `.html` and `.txt` files to `.email-previews/` (git-ignored). No provider
credentials needed — this renders locally without sending anything.

## Optional subsystems

- **Object storage** is off by default (`STORAGE_DRIVER=none`). See [storage/](storage/README.md).
- **Email sending** needs SMTP credentials; rendering and previews work without them. See [email/](email/README.md).
