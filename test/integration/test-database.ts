import * as dotenv from 'dotenv';
import { resolve } from 'path';

/**
 * Resolves DATABASE_URL_TEST from the environment or .env.local and refuses
 * to run against anything that could be the dev database.
 */
export function resolveTestDatabaseUrl(): string {
  dotenv.config({ path: resolve(__dirname, '../../.env.local'), quiet: true });
  const url = process.env.DATABASE_URL_TEST;
  if (!url) {
    throw new Error(
      'DATABASE_URL_TEST is not set. Point it at a dedicated test database (see docs/setup.md).',
    );
  }
  if (url === process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL_TEST must differ from DATABASE_URL.');
  }
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!dbName.includes('test')) {
    throw new Error(
      `DATABASE_URL_TEST database "${dbName}" must have "test" in its name.`,
    );
  }
  return url;
}
