import { BadRequestException } from '@nestjs/common';
import { ProviderUploadPurpose, UploadPurpose } from '@prisma/client';
import {
  hasExpectedSignature,
  validateFile,
  validateGeneralFile,
} from './file-validation';

describe('validateFile', () => {
  it('preserves provider document extension and MIME type validation', () => {
    expect(() =>
      validateFile(
        'identity.pdf',
        'application/pdf',
        1024,
        ProviderUploadPurpose.provider_document,
      ),
    ).not.toThrow();
    expect(() =>
      validateFile(
        'identity.exe',
        'application/pdf',
        1024,
        ProviderUploadPurpose.provider_document,
      ),
    ).toThrow(BadRequestException);
  });

  it('preserves the smaller provider photo limit', () => {
    expect(() =>
      validateFile(
        'face.jpg',
        'image/jpeg',
        5 * 1024 * 1024 + 1,
        ProviderUploadPurpose.provider_photo,
      ),
    ).toThrow('This file is too large.');
  });
});

describe('validateGeneralFile', () => {
  it('accepts allowed request files below 20 MB', () => {
    expect(() =>
      validateGeneralFile(
        'brief.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        1024,
        UploadPurpose.request_attachment,
      ),
    ).not.toThrow();
  });

  it('rejects Office files for progress evidence', () => {
    expect(() =>
      validateGeneralFile(
        'evidence.docx',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        1024,
        UploadPurpose.progress_evidence,
      ),
    ).toThrow(BadRequestException);
  });
});

describe('hasExpectedSignature', () => {
  it.each([
    [Buffer.from('%PDF-1.7'), 'application/pdf', true],
    [Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png', true],
    [Buffer.from([0xff, 0xd8, 0xff]), 'image/jpeg', true],
    [Buffer.from('RIFF0000WEBP'), 'image/webp', true],
    [Buffer.from('PK\u0003\u0004'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', true],
    [Buffer.from('0000ftypisom'), 'video/mp4', true],
    [Buffer.from('not a pdf'), 'application/pdf', false],
    [Buffer.from(''), 'application/unknown', false],
  ])('checks signature for %s', (bytes, type, expected) => {
    expect(hasExpectedSignature(bytes as Buffer, type as string)).toBe(expected);
  });
});
