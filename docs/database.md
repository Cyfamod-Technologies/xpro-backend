# Database

## Prisma setup

Prisma 6 with PostgreSQL 16. No database extensions are required.

- **Schema file**: `prisma/schema.prisma` — all models in one file.
- **Migrations**: `prisma/migrations/` — applied migration directories.
- **Client**: generated to the default location, imported via `@prisma/client`.

## Common commands

```bash
# Generate the Prisma client after schema changes
npm run generate        # → npx prisma generate

# Create and apply a new migration during development
npm run migrate         # → npx prisma migrate dev

# Apply existing migrations in production/CI (no new migration created)
npx prisma migrate deploy

# Open the database browser
npm run studio          # → npx prisma studio
```

## Models

The template ships four models. Everything else is yours to add.

| Model | Purpose |
| --- | --- |
| `User` | Accounts, roles, MFA secret, verification and login state |
| `Notification` | Outbound message record, written before queueing and updated on delivery |
| `AuditLog` | Append-only activity trail, written asynchronously |
| `FailedJob` | Dead-letter record for BullMQ jobs that exhausted retries |

## Schema conventions

- Table names use `snake_case` (PascalCase models mapped via `@@map`).
- Column names use `snake_case` (mapped from camelCase fields via `@map`).
- Every model uses a `String` primary key named `id` with `@default(uuid())`.
- Timestamps use `createdAt DateTime @default(now())` and `updatedAt DateTime @updatedAt`.
- Soft-delete patterns are not used — records are hard-deleted.

## JSON fields

Prisma's `Json` type maps to PostgreSQL `jsonb`. Store only plain serializable values:

```ts
// Wrong — class instance is not serializable
data: { config: dto }

// Correct — spread to a plain object
data: { config: { key: dto.key, value: dto.value } as Prisma.InputJsonValue }
```

DTO class instances with methods or non-enumerable properties must be spread or
reconstructed as plain objects before being persisted to `Json` columns.

## Transactions

Use `prisma.$transaction([...])` for arrays of independent operations that must
succeed atomically:

```ts
await this.prisma.$transaction([
  this.prisma.notification.update({ where: { id }, data: { status: 'sent' } }),
  this.prisma.failedJob.delete({ where: { id: failedJobId } }),
]);
```

Use `prisma.$transaction(async (tx) => { ... })` for interactive transactions that
need to read and write in sequence:

```ts
await this.prisma.$transaction(async (tx) => {
  const row = await tx.someModel.findUniqueOrThrow({ where: { id } });
  await tx.someModel.update({ where: { id }, data: { version: row.version + 1 } });
});
```

## Raw SQL

Use `$executeRaw` and `$queryRaw` only when Prisma's query builder cannot express
the operation. Always use tagged template literals so values are parameterised:

```ts
await prisma.$executeRaw`DELETE FROM "audit_logs" WHERE "created_at" < ${cutoff}`;
```

Never interpolate variables with string concatenation in raw queries — that
reintroduces SQL injection.

## Migration rules

- After any schema change, run `npm run migrate` to create a named migration.
- Never edit files inside an already-applied migration directory.
- Migration file names follow the pattern `YYYYMMDDHHMMSS_description`.
- In production use `npx prisma migrate deploy` (no interactive prompt, no drift check).
- CI lints every migration a PR adds with [Squawk](https://squawkhq.com) (rules in
  `.squawk.toml`). It fails the PR on statements that can break against a table
  that already has rows: a `NOT NULL` column, a `UNIQUE` constraint, or a
  foreign key added to an existing table. Make the change safe (nullable first,
  backfill, then constrain), or, once you have confirmed the existing rows
  satisfy it, accept it on purpose with a comment on the line above:

  ```sql
  -- squawk-ignore constraint-missing-not-valid,adding-foreign-key-constraint
  ALTER TABLE "payments" ADD CONSTRAINT "payments_request_id_fkey" ...
  ```

The template ships a single `00000000000000_init` migration. If you make schema
changes before your first deploy, it is cleaner to delete it and regenerate one
init migration than to stack a second migration on top:

```bash
rm -rf prisma/migrations/00000000000000_init
npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/00000000000000_init/migration.sql
```

## Enums

All enums live in `prisma/schema.prisma` and are imported from `@prisma/client`.
Do not redefine them as TypeScript enums.

- `AppRole`: `super_admin`, `admin`, `user`
- `AppSurface`: `admin`, `user`
- `AccountStatus`: `invited`, `active`, `inactive`, `suspended`, `archived`

## Seed scripts

Both seed scripts use `PrismaClient` directly (they run outside the NestJS
container) and use `upsert`, so they are safe to re-run.

- `seed-super-admin.ts` — creates a `super_admin` platform operator.
- `seed-sample-user.ts` — creates an ordinary `user`, already active and verified.

See [setup.md](setup.md) for commands and flags.

## Seeding

Reference data that has to be the same in every environment, such as the service
catalog, is seeded from `src/seeds`, not written into migrations. Migrations stay
schema-only (the first catalog in `20261029110000_seed_service_catalog` is history
and is never edited); a seed brings that data to the current shape.

```
src/seeds/
  run.ts            entry point (the command below)
  registry.ts       the seeds, in the order they run: add one line to register a seed
  runner.ts         ledger check, transaction, dry run, audit entry
  seed.types.ts     the Seed interface: name, version, checksum, apply(tx)
  catalog/
    catalog.data.ts the target catalog as typed data with fixed UUIDs
    seed-catalog.ts applies it with Prisma in one transaction
    provider-ids.ts rewrites provider skill ids when nodes are replaced or deleted
```

```bash
npm run seed                      # run every seed not yet applied (reads .env.local)
npm run seed -- --only=catalog    # one seed
npm run seed -- --force           # re-apply a seed already recorded
npm run seed -- --dry-run         # run it, print what it would change, roll back
npm run seed:prod                 # node dist/seeds/run.js, for the production image
```

Run it after `npx prisma migrate deploy`. It exits non-zero if a seed fails, so a
deploy step can gate on it.

### The ledger and versions

Each seed declares a `name` and a `version`. `data_seeds` records the version
applied. A plain run skips a seed whose recorded version is at or above its own,
so the command is safe on every deploy and never overwrites an edit an admin made
after seeding (a renamed service stays renamed). The ledger row is written in the
same transaction as the seed, so a failed seed leaves nothing behind. A run takes
an advisory lock, so two deploys starting together apply it once.

Change a seed's data on purpose by editing its data file and **bumping `version`**.
If the data changes but the version does not, the runner skips it and logs a
warning (the recorded checksum differs). `--force` re-applies the current data
whatever the ledger says, which also reverts admin edits to the seeded fields.

### Writing a seed

Make `apply(tx)` idempotent: look rows up by fixed id, write only what differs and
return counts of what changed (all zero on a second pass). Use Prisma through `tx`
and the existing helpers, for example `renameInProfiles`, so seeding does what the
admin screens do.
