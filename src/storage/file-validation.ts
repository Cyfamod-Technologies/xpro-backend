import { ProviderUploadPurpose, UploadPurpose } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';

const MAX_UPLOAD_SIZE = 20 * 1024 * 1024;
const MAX_PROVIDER_PHOTO_SIZE = 5 * 1024 * 1024;

type FileRule = { extensions: readonly string[]; types: readonly string[] };

const GENERAL_RULES: Record<UploadPurpose, FileRule> = {
  request_attachment: {
    extensions: [
      'pdf',
      'png',
      'jpg',
      'jpeg',
      'webp',
      'doc',
      'docx',
      'xls',
      'xlsx',
      'mp4',
    ],
    types: [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'video/mp4',
    ],
  },
  message_attachment: {
    extensions: [
      'pdf',
      'png',
      'jpg',
      'jpeg',
      'webp',
      'doc',
      'docx',
      'xls',
      'xlsx',
      'mp4',
    ],
    types: [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'video/mp4',
    ],
  },
  progress_evidence: {
    extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'mp4'],
    types: [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/webp',
      'video/mp4',
    ],
  },
  payment_proof: {
    extensions: [
      'pdf',
      'png',
      'jpg',
      'jpeg',
      'webp',
      'doc',
      'docx',
      'xls',
      'xlsx',
      'mp4',
    ],
    types: [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'video/mp4',
    ],
  },
};

const PROVIDER_RULES: Record<ProviderUploadPurpose, FileRule> = {
  provider_document: {
    extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp', 'doc', 'docx'],
    types: [
      'application/pdf',
      'image/png',
      'image/jpeg',
      'image/webp',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
  },
  provider_photo: {
    extensions: ['png', 'jpg', 'jpeg', 'webp'],
    types: ['image/png', 'image/jpeg', 'image/webp'],
  },
  provider_portfolio: {
    extensions: ['pdf', 'png', 'jpg', 'jpeg', 'webp'],
    types: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'],
  },
};

function matchesRule(name: string, type: string, rule: FileRule): boolean {
  const extension = name.split('.').pop()?.toLowerCase();
  return rule.extensions.includes(extension ?? '') && rule.types.includes(type);
}

export function validateFile(
  name: string,
  type: string,
  size: number,
  purpose: ProviderUploadPurpose,
): void {
  if (!matchesRule(name, type, PROVIDER_RULES[purpose]))
    throw new BadRequestException('Use a supported file type for this upload.');
  if (
    size > MAX_UPLOAD_SIZE ||
    (purpose === ProviderUploadPurpose.provider_photo &&
      size > MAX_PROVIDER_PHOTO_SIZE)
  )
    throw new BadRequestException('This file is too large.');
}

export function validateGeneralFile(
  name: string,
  type: string,
  size: number,
  purpose: UploadPurpose,
): void {
  if (!matchesRule(name, type, GENERAL_RULES[purpose]))
    throw new BadRequestException(
      'Use PDF, image, Office or MP4 files smaller than 20 MB.',
    );
  if (size <= 0 || size > MAX_UPLOAD_SIZE)
    throw new BadRequestException(
      'Use PDF, image, Office or MP4 files smaller than 20 MB.',
    );
}

export function hasExpectedSignature(bytes: Buffer, type: string): boolean {
  if (type === 'application/pdf')
    return bytes.subarray(0, 5).toString() === '%PDF-';
  if (type === 'image/png')
    return bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (type === 'image/jpeg')
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/webp')
    return (
      bytes.subarray(0, 4).toString() === 'RIFF' &&
      bytes.subarray(8, 12).toString() === 'WEBP'
    );
  if (
    type.startsWith('application/vnd.openxmlformats-officedocument') ||
    type === 'video/mp4'
  )
    return (
      bytes.subarray(0, 2).toString() === 'PK' ||
      (type === 'video/mp4' && bytes.subarray(4, 8).toString() === 'ftyp')
    );
  if (type === 'application/vnd.ms-excel')
    return bytes.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  if (type === 'application/msword')
    return bytes.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  return false;
}
