import { resolveTestDatabaseUrl } from './test-database';

process.env.DATABASE_URL = resolveTestDatabaseUrl();
