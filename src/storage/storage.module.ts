import { S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  resolveStorageConfig,
  S3_CLIENT,
  STORAGE_CONFIG,
  type StorageConfig,
} from './storage.config';
import { StorageService } from './storage.service';

/**
 * Opt-in object storage. Not imported by AppModule — add it to a feature
 * module's imports once STORAGE_DRIVER is set to something other than `none`.
 * Importing it while storage is off fails loudly at boot rather than handing
 * out a service that throws on first use.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: STORAGE_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): StorageConfig => {
        const resolved = resolveStorageConfig(config);
        if (!resolved) {
          throw new Error(
            'StorageModule was imported but STORAGE_DRIVER is "none". Set STORAGE_DRIVER=r2 and the STORAGE_* variables, or drop the import. See docs/storage/README.md.',
          );
        }
        return resolved;
      },
    },
    {
      provide: S3_CLIENT,
      inject: [STORAGE_CONFIG],
      useFactory: (storage: StorageConfig) =>
        new S3Client({
          region: storage.region,
          endpoint: storage.endpoint,
          // R2 requires path-style addressing.
          forcePathStyle: true,
          credentials: {
            accessKeyId: storage.accessKeyId,
            secretAccessKey: storage.secretAccessKey,
          },
          // The AWS SDK sends CRC32 integrity headers by default since
          // v3.729. R2 rejects them, so only send a checksum when the
          // operation actually requires one. Harmless on real S3.
          requestChecksumCalculation: 'WHEN_REQUIRED',
          responseChecksumValidation: 'WHEN_REQUIRED',
        }),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
