import { ConflictException } from '@nestjs/common';
import { Prisma, UploadPurpose, UploadStatus } from '@prisma/client';
import { UploadsService } from './uploads.service';

describe('UploadsService.attach', () => {
  const readyUpload = {
    id: 'upload-id',
    ownerId: 'owner-id',
    purpose: UploadPurpose.request_attachment,
    status: UploadStatus.ready,
    fileName: 'brief.pdf',
    contentType: 'application/pdf',
    size: 1024,
    storageKey: 'request_attachment/2026/10/upload-id',
    entityType: null,
    entityId: null,
    expiresAt: new Date('2026-10-24T00:00:00.000Z'),
    completedAt: new Date('2026-10-23T00:00:00.000Z'),
    attachedAt: null,
    createdAt: new Date('2026-10-23T00:00:00.000Z'),
  };

  function createService(foundUploads: typeof readyUpload[]) {
    const transaction = {
      upload: {
        findMany: jest.fn().mockResolvedValue(foundUploads),
        updateMany: jest.fn().mockResolvedValue({ count: foundUploads.length }),
      },
    } as unknown as Prisma.TransactionClient;
    const service = new UploadsService({} as never, {} as never);
    return { service, transaction };
  }

  it.each([
    { description: 'someone else’s upload', found: [] },
    { description: 'a pending upload', found: [] },
    { description: 'an upload with the wrong purpose', found: [] },
  ])('rejects $description', async ({ found }) => {
    const { service, transaction } = createService(found as typeof readyUpload[]);
    await expect(
      service.attach(
        transaction,
        ['upload-id'],
        'owner-id',
        UploadPurpose.request_attachment,
        'request',
        'request-id',
      ),
    ).rejects.toThrow(
      "One of your files didn't finish uploading. Remove it and try again.",
    );
    expect(transaction.upload.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: { in: ['upload-id'] },
        ownerId: 'owner-id',
        purpose: UploadPurpose.request_attachment,
        status: UploadStatus.ready,
      }),
    });
  });

  it('marks owned, ready files attached to the entity inside the caller transaction', async () => {
    const { service, transaction } = createService([readyUpload]);
    const result = await service.attach(
      transaction,
      ['upload-id'],
      'owner-id',
      UploadPurpose.request_attachment,
      'request',
      'request-id',
    );
    expect(transaction.upload.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: UploadStatus.ready }),
        data: expect.objectContaining({
          status: UploadStatus.attached,
          entityType: 'request',
          entityId: 'request-id',
        }),
      }),
    );
    expect(result[0]).toMatchObject({ status: UploadStatus.attached, entityId: 'request-id' });
  });

  it('rejects a duplicate id and rolls back the caller transaction', async () => {
    const { service, transaction } = createService([readyUpload]);
    await expect(
      service.attach(
        transaction,
        ['upload-id', 'upload-id'],
        'owner-id',
        UploadPurpose.request_attachment,
        'request',
        'request-id',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(transaction.upload.updateMany).not.toHaveBeenCalled();
  });
});
