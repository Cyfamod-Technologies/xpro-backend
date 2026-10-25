/**
 * Runs the boot-time environment validation without starting the app, so a
 * deploy can reject a bad env file before rolling out a container. Because it
 * calls the same validateEnv() as ConfigModule, the deploy check cannot drift
 * from what the app enforces at boot.
 *
 * Usage (inside the built image, no network needed):
 *   docker run --rm --network none --env-file <file> <image> \
 *     node dist/scripts/validate-env.js
 */

import { validateEnv } from '../config/env.validation';

try {
  validateEnv(process.env);
  console.log(
    `Environment is valid (NODE_ENV=${process.env.NODE_ENV ?? 'unset'}).`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
