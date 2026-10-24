import { NotFoundException } from '@nestjs/common';
import { UploadPurpose, UploadStatus } from '@prisma/client';
import { RequestUser } from '../common/types/request-user';
import { FileAccessService } from './file-access.service';

describe('FileAccessService', () => {
  const actor = {
    id: 'user-1',
    email: 'user@example.test',
    role: 'user',
    surfaces: [],
  } as unknown as RequestUser;
  const upload = {
    id: 'upload-1',
    ownerId: 'user-1',
    purpose: UploadPurpose.request_attachment,
    status: UploadStatus.attached,
    fileName: 'brief.pdf',
    contentType: 'application/pdf',
    size: 100,
    storageKey: 'request_attachment/2026/10/upload-1',
    entityType: 'request',
    entityId: 'request-1',
    expiresAt: new Date(),
    completedAt: new Date(),
    attachedAt: new Date(),
    createdAt: new Date(),
  };

  function createService() {
    const prisma = {
      upload: { findFirst: jest.fn().mockResolvedValue(upload) },
    };
    const storage = {
      signedDownloadUrl: jest
        .fn()
        .mockResolvedValue('https://signed.test/file'),
    };
    return {
      service: new FileAccessService(prisma as never, storage as never),
      prisma,
      storage,
    };
  }

  it('returns not found when no entity resolver is registered', async () => {
    const { service, storage } = createService();
    await expect(service.getFileUrl(actor, upload.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(storage.signedDownloadUrl).not.toHaveBeenCalled();
  });

  it('returns a short lived URL only after the entity resolver allows access', async () => {
    const { service, storage } = createService();
    const resolver = jest.fn().mockResolvedValue(true);
    service.register('request', resolver);
    await expect(service.getFileUrl(actor, upload.id)).resolves.toEqual({
      url: 'https://signed.test/file',
      expiresInSeconds: 300,
    });
    expect(resolver).toHaveBeenCalledWith(actor, upload);
    expect(storage.signedDownloadUrl).toHaveBeenCalledWith(
      upload.storageKey,
      300,
      upload.fileName,
    );
  });

  it('hides files when the entity resolver denies access', async () => {
    const { service, storage } = createService();
    service.register('request', jest.fn().mockResolvedValue(false));
    await expect(service.getFileUrl(actor, upload.id)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(storage.signedDownloadUrl).not.toHaveBeenCalled();
  });
});
