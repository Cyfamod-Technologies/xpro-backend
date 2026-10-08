/**
 * One-time template rename. Run `npm run init` right after cloning, then delete
 * this file and the `init` script from package.json.
 *
 * Rewrites the placeholder identity (`Acme`, `app`, `app_db`, `app_session`,
 * `nestjs-prisma-postgres-template`) across package.json, .env.example, both
 * compose files, the session cookie constant, the deploy example and the docs.
 *
 * Non-interactive use:
 *   npm run init -- --name "Northwind" --slug northwind --db northwind_db
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as readline from 'node:readline/promises';

const root = resolve(__dirname, '..');

interface Identity {
  displayName: string;
  slug: string;
  dbName: string;
  cookieName: string;
}

function parseArgs(): Record<string, string> {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    const value = args[i + 1];
    if (key && value !== undefined) result[key] = value;
  }
  return result;
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Postgres identifiers and cookie names cannot contain hyphens comfortably. */
function snakeify(value: string): string {
  return slugify(value).replace(/-/g, '_');
}

/** Replaces every occurrence, but only rewrites the file if something changed. */
function rewrite(relativePath: string, edits: [RegExp | string, string][]) {
  const path = resolve(root, relativePath);
  if (!existsSync(path)) {
    console.log(`  skipped ${relativePath} (not found)`);
    return;
  }

  const original = readFileSync(path, 'utf8');
  let next = original;
  for (const [from, to] of edits) {
    next =
      typeof from === 'string' ? next.split(from).join(to) : next.replace(from, to);
  }

  if (next === original) {
    console.log(`  unchanged ${relativePath}`);
    return;
  }

  writeFileSync(path, next);
  console.log(`  updated ${relativePath}`);
}

function applyIdentity(id: Identity) {
  const { displayName, slug, dbName, cookieName } = id;

  rewrite('package.json', [
    ['"name": "nestjs-prisma-postgres-template"', `"name": "${slug}"`],
    [
      '"description": "NestJS + Prisma + PostgreSQL backend template with auth, sessions, MFA, queues, email and audit logging"',
      `"description": "${displayName} API"`,
    ],
  ]);

  rewrite('.env.example', [
    ['APP_NAME=Acme', `APP_NAME=${displayName}`],
    ['SERVICE=Acme API', `SERVICE=${displayName} API`],
    ['EMAIL_FROM_NAME=Acme', `EMAIL_FROM_NAME=${displayName}`],
    [
      'DATABASE_URL=postgresql://app:app@localhost:5432/app_db?schema=public',
      `DATABASE_URL=postgresql://${snakeify(slug)}:${snakeify(slug)}@localhost:5432/${dbName}?schema=public`,
    ],
    ['POSTGRES_USER=app', `POSTGRES_USER=${snakeify(slug)}`],
    ['POSTGRES_PASSWORD=app', `POSTGRES_PASSWORD=${snakeify(slug)}`],
    ['POSTGRES_DB=app_db', `POSTGRES_DB=${dbName}`],
  ]);

  for (const composeFile of ['docker-compose.yml', 'docker-compose.prod.yml']) {
    rewrite(composeFile, [
      ['name: nestjs-prisma-postgres-template', `name: ${slug}`],
      ['container_name: app-api', `container_name: ${slug}-api`],
      ['container_name: app-postgres', `container_name: ${slug}-postgres`],
      ['container_name: app-redis', `container_name: ${slug}-redis`],
      ['image: app-api:latest', `image: ${slug}-api:latest`],
      ['${POSTGRES_USER:-app}', `\${POSTGRES_USER:-${snakeify(slug)}}`],
      ['${POSTGRES_PASSWORD:-app}', `\${POSTGRES_PASSWORD:-${snakeify(slug)}}`],
      ['${POSTGRES_DB:-app_db}', `\${POSTGRES_DB:-${dbName}}`],
      [
        'NestJS Prisma Postgres Template — Docker Compose',
        `${displayName} — Docker Compose`,
      ],
    ]);
  }

  rewrite('src/auth/auth.constants.ts', [
    ["export const SESSION_COOKIE_NAME = 'app_session';", `export const SESSION_COOKIE_NAME = '${cookieName}';`],
    [
      ' `npm run init` rewrites this for a new project.',
      ' Renamed by `npm run init`.',
    ],
  ]);

  rewrite('README.md', [
    ['# NestJS Prisma Postgres Template', `# ${displayName}`],
  ]);

  rewrite('AGENTS.md', [
    [
      '# NestJS Prisma Postgres Template — Agent Bootstrap Guide',
      `# ${displayName} — Agent Bootstrap Guide`,
    ],
  ]);

  rewrite('docs/folder-structure.md', [
    ['nestjs-prisma-postgres-template/', `${slug}/`],
  ]);

  rewrite('.github/workflows/deploy.yml.example', [
    ['DEPLOY_ROOT=/var/www/app/be', `DEPLOY_ROOT=/var/www/${slug}/be`],
    ['PROJECT=app-prod', `PROJECT=${slug}-prod`],
    ['PROJECT=app-staging', `PROJECT=${slug}-staging`],
  ]);
}

async function main() {
  const args = parseArgs();
  let displayName = args['name'];

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    if (!displayName) {
      displayName = (await rl.question('Project name (e.g. Northwind): ')).trim();
    }

    if (!displayName) {
      console.error('A project name is required.');
      process.exit(1);
    }

    const defaultSlug = slugify(displayName);
    const slug = args['slug'] || defaultSlug;
    const dbName = args['db'] || `${snakeify(slug)}_db`;
    const cookieName = args['cookie'] || `${snakeify(slug)}_session`;

    const identity: Identity = { displayName, slug, dbName, cookieName };

    console.log('\nAbout to apply:');
    console.log(`  Display name   ${displayName}`);
    console.log(`  Package / slug ${slug}`);
    console.log(`  Database       ${dbName}`);
    console.log(`  Session cookie ${cookieName}\n`);

    if (!args['name']) {
      const confirm = (await rl.question('Proceed? [Y/n] ')).trim().toLowerCase();
      if (confirm && confirm !== 'y' && confirm !== 'yes') {
        console.log('Aborted — nothing was changed.');
        return;
      }
    }

    console.log('');
    applyIdentity(identity);

    console.log('\nDone. Remaining manual steps:');
    console.log('  1. Update .env with the new DATABASE_URL and POSTGRES_* values');
    console.log('  2. Rewrite the intro paragraph of README.md');
    console.log('  3. Delete scripts/init-template.ts and the "init" script in package.json');
    console.log(
      '  4. If containers already ran under the old names: docker compose down -v',
    );
  } finally {
    rl.close();
  }
}

void main();
