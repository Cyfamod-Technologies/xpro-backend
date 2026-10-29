import { ConflictException } from '@nestjs/common';
import { Prisma, UploadPurpose, UploadStatus } from '@prisma/client';
import { UploadsService } from './uploads.service';
import { REQUEST_ENTITY } from './entity-types';

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

  function createService(foundUploads: (typeof readyUpload)[]) {
    const findMany = jest.fn().mockResolvedValue(foundUploads);
    const updateMany = jest
      .fn()
      .mockResolvedValue({ count: foundUploads.length });
    const transaction = {
      upload: {
        findMany,
        updateMany,
      },
    } as unknown as Prisma.TransactionClient;
    const service = new UploadsService({} as never, {} as never);
    return { service, transaction, findMany, updateMany };
  }

  it.each([
    { description: 'someone else’s upload', found: [] },
    { description: 'a pending upload', found: [] },
    { description: 'an upload with the wrong purpose', found: [] },
  ])('rejects $description', async ({ found }) => {
    const { service, transaction, findMany } = createService(found);
    await expect(
      service.attach(
        transaction,
        ['upload-id'],
        'owner-id',
        UploadPurpose.request_attachment,
        REQUEST_ENTITY,
        'request-id',
      ),
    ).rejects.toThrow(
      "One of your files didn't finish uploading. Remove it and try again.",
    );
    expect(findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: { in: ['upload-id'] },
        ownerId: 'owner-id',
        purpose: UploadPurpose.request_attachment,
        status: UploadStatus.ready,
      }) as unknown,
    });
  });

  it('marks owned, ready files attached to the entity inside the caller transaction', async () => {
    const { service, transaction, updateMany } = createService([readyUpload]);
    const result = await service.attach(
      transaction,
      ['upload-id'],
      'owner-id',
      UploadPurpose.request_attachment,
      REQUEST_ENTITY,
      'request-id',
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: UploadStatus.ready,
        }) as unknown,
        data: expect.objectContaining({
          status: UploadStatus.attached,
          entityType: REQUEST_ENTITY,
          entityId: 'request-id',
        }) as unknown,
      }),
    );
    expect(result[0]).toMatchObject({
      status: UploadStatus.attached,
      entityId: 'request-id',
    });
  });

  it('rejects a duplicate id and rolls back the caller transaction', async () => {
    const { service, transaction, updateMany } = createService([readyUpload]);
    await expect(
      service.attach(
        transaction,
        ['upload-id', 'upload-id'],
        'owner-id',
        UploadPurpose.request_attachment,
        REQUEST_ENTITY,
        'request-id',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
