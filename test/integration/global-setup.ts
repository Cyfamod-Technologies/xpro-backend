import { execSync } from 'child_process';
import { resolve } from 'path';
import { resolveTestDatabaseUrl } from './test-database';

export default function globalSetup() {
  const url = resolveTestDatabaseUrl();
  execSync('npx prisma migrate deploy', {
    cwd: resolve(__dirname, '../..'),
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}
