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
 * Optional object storage. Features requiring files return service unavailable
 * while STORAGE_DRIVER is `none`, without preventing unrelated API routes from booting.
 */
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: STORAGE_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService): StorageConfig =>
        resolveStorageConfig(config),
    },
    {
      provide: S3_CLIENT,
      inject: [STORAGE_CONFIG],
      useFactory: (storage: StorageConfig) =>
        new S3Client({
          region: storage.region ?? 'auto',
          endpoint: storage.endpoint,
          // R2 requires path-style addressing.
          forcePathStyle: true,
          credentials: {
            accessKeyId: storage.accessKeyId ?? '',
            secretAccessKey: storage.secretAccessKey ?? '',
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
