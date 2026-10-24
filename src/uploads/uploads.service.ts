import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma, Upload, UploadPurpose, UploadStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  hasExpectedSignature,
  validateGeneralFile,
} from '../storage/file-validation';
import { StorageService } from '../storage/storage.service';
import { CreateUploadDto } from './dto/create-upload.dto';

const UPLOAD_NOT_FINISHED =
  "One of your files didn't finish uploading. Remove it and try again.";
const UPLOAD_TTL_MS = 10 * 60 * 1000;
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class UploadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async create(ownerId: string, dto: CreateUploadDto) {
    validateGeneralFile(dto.name, dto.type, dto.size, dto.purpose);
    const id = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + UPLOAD_TTL_MS);
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const key = `${dto.purpose}/${year}/${month}/${id}`;
    let uploadUrl: string;
    try {
      uploadUrl = await this.storage.signedUploadUrl(key, dto.type, 600);
    } catch (error) {
      if (error instanceof ServiceUnavailableException)
        throw new ServiceUnavailableException(
          'File uploads are not configured.',
        );
      throw error;
    }
    await this.prisma.upload.create({
      data: {
        id,
        ownerId,
        purpose: dto.purpose,
        fileName: dto.name,
        contentType: dto.type,
        size: dto.size,
        storageKey: key,
        expiresAt,
      },
    });
    return {
      id,
      uploadUrl,
      method: 'PUT',
      headers: { 'Content-Type': dto.type },
      expiresAt,
    };
  }

  async complete(ownerId: string, id: string) {
    const upload = await this.prisma.upload.findFirst({
      where: { id, ownerId, status: UploadStatus.pending },
    });
    if (!upload)
      throw new NotFoundException('Upload not found or already completed.');
    if (upload.expiresAt <= new Date())
      throw new ConflictException(
        'This upload has expired. Start the upload again.',
      );

    let object: { contentType?: string; contentLength?: number };
    try {
      object = await this.storage.head(upload.storageKey);
    } catch (error) {
      if (error instanceof ServiceUnavailableException)
        throw new ServiceUnavailableException(
          'File uploads are not configured.',
        );
      throw error;
    }
    if (
      object.contentLength !== upload.size ||
      object.contentType !== upload.contentType
    )
      throw new ConflictException(
        'Uploaded file size or type does not match the upload request.',
      );
    let bytes: Buffer;
    try {
      bytes = await this.storage.read(upload.storageKey);
    } catch (error) {
      if (error instanceof ServiceUnavailableException)
        throw new ServiceUnavailableException(
          'File uploads are not configured.',
        );
      throw error;
    }
    if (!hasExpectedSignature(bytes, upload.contentType))
      throw new ConflictException(
        'The uploaded file content does not match its type.',
      );

    const updated = await this.prisma.upload.updateMany({
      where: { id, ownerId, status: UploadStatus.pending },
      data: { status: UploadStatus.ready, completedAt: new Date() },
    });
    if (updated.count !== 1)
      throw new NotFoundException('Upload not found or already completed.');
    return {
      id: upload.id,
      name: upload.fileName,
      size: upload.size,
      type: upload.contentType,
      status: UploadStatus.ready,
    };
  }

  async delete(ownerId: string, id: string) {
    const upload = await this.prisma.upload.findFirst({
      where: { id, ownerId },
    });
    if (!upload) throw new NotFoundException('File not found.');
    if (upload.status === UploadStatus.attached)
      throw new ConflictException('Attached files cannot be discarded.'); // new message: not in spec
    const claimed = await this.prisma.upload.updateMany({
      where: { id, ownerId, status: upload.status },
      data: { status: UploadStatus.expired },
    });
    if (claimed.count !== 1)
      throw new NotFoundException('Upload not found or already completed.');
    try {
      await this.storage.delete(upload.storageKey);
    } catch (error) {
      if (error instanceof ServiceUnavailableException)
        throw new ServiceUnavailableException(
          'File uploads are not configured.',
        );
      throw error;
    }
    await this.prisma.upload.delete({ where: { id } });
    return { deleted: true };
  }

  async attach(
    tx: Prisma.TransactionClient,
    uploadIds: string[],
    ownerId: string,
    purpose: UploadPurpose,
    entityType: string,
    entityId: string,
  ): Promise<Upload[]> {
    if (!uploadIds.length) return [];
    if (uploadIds.length > 6)
      throw new ConflictException('Attach up to six files at a time.');
    const uniqueIds = [...new Set(uploadIds)];
    if (uniqueIds.length !== uploadIds.length)
      throw new ConflictException(UPLOAD_NOT_FINISHED);
    const uploads = await tx.upload.findMany({
      where: {
        id: { in: uniqueIds },
        ownerId,
        purpose,
        status: UploadStatus.ready,
      },
    });
    if (uploads.length !== uniqueIds.length)
      throw new ConflictException(UPLOAD_NOT_FINISHED);
    if (
      uploads.reduce((total, upload) => total + upload.size, 0) >
      25 * 1024 * 1024
    )
      throw new ConflictException('Keep the combined file size under 25 MB.');

    const attachedAt = new Date();
    const updated = await tx.upload.updateMany({
      where: {
        id: { in: uniqueIds },
        ownerId,
        purpose,
        status: UploadStatus.ready,
      },
      data: {
        status: UploadStatus.attached,
        entityType,
        entityId,
        attachedAt,
      },
    });
    if (updated.count !== uniqueIds.length)
      throw new ConflictException(UPLOAD_NOT_FINISHED);
    return uploads.map((upload) => ({
      ...upload,
      status: UploadStatus.attached,
      entityType,
      entityId,
      attachedAt,
    }));
  }

  async cleanupUnattachedOlderThan24Hours(now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - ORPHAN_TTL_MS);
    const stale = await this.prisma.upload.findMany({
      where: {
        status: { not: UploadStatus.attached },
        createdAt: { lt: cutoff },
      },
      select: { id: true, storageKey: true },
    });
    let deleted = 0;
    for (const upload of stale) {
      const claimed = await this.prisma.upload.updateMany({
        where: {
          id: upload.id,
          status: { not: UploadStatus.attached },
          createdAt: { lt: cutoff },
        },
        data: { status: UploadStatus.expired },
      });
      if (claimed.count !== 1) continue;
      try {
        await this.storage.delete(upload.storageKey);
      } catch (error) {
        if (!(error instanceof ServiceUnavailableException)) throw error;
      }
      await this.prisma.upload.delete({ where: { id: upload.id } });
      deleted++;
    }
    return deleted;
  }
}
