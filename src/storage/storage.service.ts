import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  S3_CLIENT,
  STORAGE_CONFIG,
  type StorageConfig,
} from './storage.config';

/**
 * Thin wrapper over the S3 API. Configuration is resolved in StorageModule and
 * injected, so this class never reads env directly and cannot block boot when
 * storage is switched off.
 */
@Injectable()
export class StorageService {
  private readonly bucket: string;
  private readonly publicBaseUrl: string;
  private readonly enabled: boolean;

  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    @Inject(STORAGE_CONFIG) storage: StorageConfig,
  ) {
    this.bucket = storage.bucket ?? '';
    this.publicBaseUrl = storage.publicUrl.replace(/\/$/, '');
    this.enabled = storage.driver !== 'none';
  }

  async upload(
    key: string,
    body: Buffer | Uint8Array | string,
    contentType: string,
  ): Promise<string> {
    this.requireEnabled();
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );

    return this.publicUrl(key);
  }

  async delete(key: string): Promise<void> {
    this.requireEnabled();
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async head(
    key: string,
  ): Promise<{ contentType?: string; contentLength?: number }> {
    this.requireEnabled();
    const result = await this.s3.send(
      new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    return {
      contentType: result.ContentType,
      contentLength: result.ContentLength,
    };
  }

  async signedUploadUrl(
    key: string,
    contentType: string,
    expiresIn = 300,
  ): Promise<string> {
    this.requireEnabled();
    return getSignedUrl(
      this.s3,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn },
    );
  }

  async signedDownloadUrl(
    key: string,
    expiresIn = 300,
    filename?: string,
  ): Promise<string> {
    this.requireEnabled();
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: filename
          ? `attachment; filename="${filename}"`
          : 'attachment',
        ResponseContentType: key.endsWith('.txt')
          ? 'text/plain; charset=utf-8'
          : undefined,
      }),
      { expiresIn },
    );
  }

  /** Signed GET that renders in the browser (e.g. as an <img>) instead of downloading. */
  async signedViewUrl(key: string, expiresIn = 3600): Promise<string> {
    this.requireEnabled();
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: 'inline',
      }),
      { expiresIn },
    );
  }

  publicUrl(key: string): string {
    return `${this.publicBaseUrl}/${key}`;
  }

  /** Convenience wrapper — uploads as octet-stream. */
  async store(key: string, data: Buffer): Promise<void> {
    await this.upload(key, data, 'application/octet-stream');
  }

  /** Convenience wrapper — downloads and returns a Buffer. */
  async read(key: string): Promise<Buffer> {
    this.requireEnabled();
    const { Body } = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!Body) throw new Error(`Empty body for storage key: ${key}`);
    return Buffer.from(await Body.transformToByteArray());
  }

  private requireEnabled(): void {
    if (!this.enabled)
      throw new ServiceUnavailableException(
        'Object storage is not configured.',
      );
  }
}
