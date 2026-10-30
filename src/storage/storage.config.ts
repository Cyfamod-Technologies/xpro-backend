import type { ConfigService } from '@nestjs/config';

export const STORAGE_CONFIG = 'STORAGE_CONFIG';
export const S3_CLIENT = 'S3_CLIENT';

/** Object-storage backends supported by the shared S3 API client. */
export type StorageDriver = 'none' | 'r2' | 's3';

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
export function resolveStorageConfig(config: ConfigService): StorageConfig {
  const driver = config.get<string>('STORAGE_DRIVER', 'none');
  if (driver === 'none') return { driver: 'none', publicUrl: '' };

  if (driver !== 'r2' && driver !== 's3') {
    throw new Error(
      `Unsupported STORAGE_DRIVER "${driver}". Supported drivers are "r2" and "s3" — see docs/storage/README.md.`,
    );
  }

  const isR2 = driver === 'r2';

  return {
    driver,
    bucket: config.getOrThrow<string>('STORAGE_BUCKET'),
    region: isR2
      ? config.get<string>('STORAGE_REGION', 'auto')
      : config.getOrThrow<string>('STORAGE_REGION'),
    endpoint: isR2 ? config.getOrThrow<string>('STORAGE_ENDPOINT') : undefined,
    accessKeyId: isR2
      ? config.getOrThrow<string>('STORAGE_ACCESS_KEY_ID')
      : config.get<string>('STORAGE_ACCESS_KEY_ID'),
    secretAccessKey: isR2
      ? config.getOrThrow<string>('STORAGE_SECRET_ACCESS_KEY')
      : config.get<string>('STORAGE_SECRET_ACCESS_KEY'),
    publicUrl: config.getOrThrow<string>('STORAGE_PUBLIC_URL'),
  };
}
