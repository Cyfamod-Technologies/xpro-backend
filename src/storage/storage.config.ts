import type { ConfigService } from '@nestjs/config';

export const STORAGE_CONFIG = 'STORAGE_CONFIG';
export const S3_CLIENT = 'S3_CLIENT';

/**
 * Object-storage backends. Only `r2` is wired up; `s3` and any other
 * S3-compatible provider differ by a handful of client options — see
 * docs/storage/s3.md for the exact changes.
 */
export type StorageDriver = 'none' | 'r2';

export interface StorageConfig {
  driver: StorageDriver;
  bucket?: string;
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** Base URL objects are served from. R2 has no default public hostname. */
  publicUrl: string;
}

/**
 * Reads STORAGE_* into a resolved config, or returns null when storage is
 * switched off. Env presence is already checked by validateEnv() at boot; this
 * re-reads rather than trusting, so the service can never be constructed with
 * half a configuration.
 */
export function resolveStorageConfig(
  config: ConfigService,
): StorageConfig {
  const driver = config.get<string>('STORAGE_DRIVER', 'none');
  if (driver === 'none') return { driver: 'none', publicUrl: '' };

  if (driver !== 'r2') {
    throw new Error(
      `Unsupported STORAGE_DRIVER "${driver}". Only "r2" is implemented — see docs/storage/README.md.`,
    );
  }

  return {
    driver,
    bucket: config.getOrThrow<string>('STORAGE_BUCKET'),
    region: config.get<string>('STORAGE_REGION', 'auto'),
    endpoint: config.getOrThrow<string>('STORAGE_ENDPOINT'),
    accessKeyId: config.getOrThrow<string>('STORAGE_ACCESS_KEY_ID'),
    secretAccessKey: config.getOrThrow<string>('STORAGE_SECRET_ACCESS_KEY'),
    publicUrl: config.getOrThrow<string>('STORAGE_PUBLIC_URL'),
  };
}
