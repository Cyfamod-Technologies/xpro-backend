import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Upload } from '@prisma/client';
import { RequestUser } from '../common/types/request-user';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';

export type UploadAccessResolver = (
  actor: RequestUser,
  upload: Upload,
) => Promise<boolean>;

@Injectable()
export class FileAccessService {
  private readonly resolvers = new Map<string, UploadAccessResolver>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  register(entityType: string, resolver: UploadAccessResolver): void {
    this.resolvers.set(entityType, resolver);
  }

  async getFileUrl(actor: RequestUser, id: string) {
    const upload = await this.prisma.upload.findFirst({
      where: { id, status: 'attached' },
    });
    if (!upload || !upload.entityType || !upload.entityId)
      throw new NotFoundException('File not found.');
    const resolver = this.resolvers.get(upload.entityType);
    if (!resolver || !(await resolver(actor, upload)))
      throw new NotFoundException('File not found.');

    let url: string;
    try {
      url = await this.storage.signedDownloadUrl(
        upload.storageKey,
        300,
        upload.fileName,
      );
    } catch (error) {
      if (error instanceof ServiceUnavailableException)
        throw new ServiceUnavailableException(
          'File uploads are not configured.',
        );
      throw error;
    }
    return {
      url,
      expiresInSeconds: 300,
    };
  }
}
