import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  Prisma,
  ProviderBankStatus,
  ProviderUploadPurpose,
  ProviderUploadStatus,
  ProviderVerificationStatus,
  StaffStatus,
} from '@prisma/client';
import { decryptSecret, encryptSecret } from '../common/utils/crypto.util';
import { RequestUser } from '../common/types/request-user';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { PrismaService } from '../prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  permissionsForRoles,
  type StaffPermission,
} from '../staff/staff-permissions';
import {
  ProviderAvailabilityDto,
  CreateProviderUploadDto,
  ProviderBankReviewDto,
  ProviderBankResolveDto,
  ProviderBankUpdateDto,
  ProviderCalendarDto,
  ProviderListQueryDto,
  ProviderChangesReviewDto,
  ProviderProfileSubmissionDto,
  ProviderReviewDto,
} from './dto/provider.dto';

const json = (value: unknown) => value as Prisma.InputJsonValue;

@Injectable()
export class ProvidersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
    private readonly config: ConfigService,
    private readonly storage: StorageService,
  ) {}

  async myProfile(userId: string) {
    await this.requireProvider(userId);
    const profile = await this.prisma.providerProfile.findUnique({
      where: { userId },
      include: {
        bankAccounts: { orderBy: { createdAt: 'desc' } },
        reviews: { orderBy: { createdAt: 'desc' } },
      },
    });
    return profile
      ? this.project(profile, true)
      : { verification: 'draft', profile: null };
  }

  async listBanks(userId: string) {
    await this.requireProvider(userId);
    const secret = this.config.get<string>('PAYSTACK_SECRET_KEY');
    if (!secret)
      throw new ServiceUnavailableException('Bank lookup is not configured.');
    let response: Response;
    try {
      response = await fetch(
        'https://api.paystack.co/bank?country=nigeria&perPage=100',
        {
          headers: { Authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(8000),
        },
      );
    } catch {
      throw new ServiceUnavailableException(
        'Bank lookup is temporarily unavailable.',
      );
    }
    if (!response.ok)
      throw new ServiceUnavailableException(
        'Bank lookup is temporarily unavailable.',
      );
    const result = (await response.json()) as {
      data?: { code: string; name: string }[];
    };
    return (result.data ?? []).map(({ code, name }) => ({ code, name }));
  }

  async resolveBankForProvider(userId: string, dto: ProviderBankResolveDto) {
    await this.requireProvider(userId);
    if (!/^\d{10}$/.test(dto.accountNumber))
      throw new BadRequestException('Enter a 10-digit account number.');
    const result = await this.resolveBank(dto.bankCode, dto.accountNumber);
    return {
      bankName: result.bankName,
      accountName: result.accountName,
      last4: dto.accountNumber.slice(-4),
    };
  }

  async createUpload(userId: string, dto: CreateProviderUploadDto) {
    await this.requireProvider(userId);
    this.validateFile(dto.name, dto.type, dto.size, dto.purpose);
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const ext = dto.name.split('.').pop()?.toLowerCase() ?? 'bin';
    const key = `provider/${dto.purpose}/${userId}/${id}.${ext}`;
    const url = await this.storage.signedUploadUrl(key, dto.type, 600);
    await this.prisma.providerUpload.create({
      data: {
        id,
        ownerId: userId,
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
      uploadUrl: url,
      method: 'PUT',
      headers: { 'Content-Type': dto.type },
      expiresAt,
    };
  }

  async completeUpload(userId: string, id: string) {
    const upload = await this.prisma.providerUpload.findFirst({
      where: { id, ownerId: userId, status: ProviderUploadStatus.pending },
    });
    if (!upload)
      throw new NotFoundException('Upload not found or already completed.');
    if (upload.expiresAt <= new Date())
      throw new ConflictException(
        'This upload has expired. Start the upload again.',
      );
    const object = await this.storage.head(upload.storageKey);
    if (
      object.contentLength !== upload.size ||
      object.contentType !== upload.contentType
    )
      throw new BadRequestException(
        'Uploaded file size or type does not match the upload request.',
      );
    const bytes = await this.storage.read(upload.storageKey);
    if (!this.hasExpectedSignature(bytes, upload.contentType))
      throw new BadRequestException(
        'The uploaded file content does not match its type.',
      );
    const updated = await this.prisma.providerUpload.update({
      where: { id },
      data: { status: ProviderUploadStatus.ready, completedAt: new Date() },
    });
    return {
      id: updated.id,
      name: updated.fileName,
      size: updated.size,
      type: updated.contentType,
      status: updated.status,
    };
  }

  async fileUrl(userId: string, id: string) {
    const upload = await this.prisma.providerUpload.findFirst({
      where: { id, ownerId: userId, status: ProviderUploadStatus.attached },
    });
    if (!upload) throw new NotFoundException('File not found.');
    return {
      url: await this.storage.signedDownloadUrl(
        upload.storageKey,
        300,
        upload.fileName,
      ),
      expiresInSeconds: 300,
    };
  }

  async reviewFileUrl(
    reviewerId: string,
    providerId: string,
    uploadId: string,
  ) {
    await this.requirePermission(reviewerId, 'provider.review');
    const profile = await this.prisma.providerProfile.findUnique({
      where: { id: providerId },
      select: { userId: true },
    });
    const upload =
      profile &&
      (await this.prisma.providerUpload.findFirst({
        where: {
          id: uploadId,
          ownerId: profile.userId,
          status: ProviderUploadStatus.attached,
        },
      }));
    if (!upload) throw new NotFoundException('File not found.');
    if (upload.purpose !== ProviderUploadPurpose.provider_portfolio)
      await this.requirePermission(reviewerId, 'view.provider_identity');
    return {
      url: await this.storage.signedDownloadUrl(
        upload.storageKey,
        300,
        upload.fileName,
      ),
      expiresInSeconds: 300,
    };
  }

  async deleteUpload(userId: string, id: string) {
    const upload = await this.prisma.providerUpload.findFirst({
      where: {
        id,
        ownerId: userId,
        status: {
          in: [ProviderUploadStatus.pending, ProviderUploadStatus.ready],
        },
      },
    });
    if (!upload) throw new NotFoundException('Unattached upload not found.');
    await this.storage.delete(upload.storageKey);
    await this.prisma.providerUpload.delete({ where: { id } });
    return { deleted: true };
  }

  async submit(userId: string, dto: ProviderProfileSubmissionDto) {
    const user = await this.requireProvider(userId);
    if (!user.emailVerifiedAt)
      throw new ForbiddenException(
        'Verify your email before submitting your provider profile.',
      );
    const normalized = this.validateSubmission(dto);
    await this.verifyAttachments(userId, dto);
    const resolved = await this.resolveBank(dto.bankCode, dto.accountNumber);
    const current = await this.prisma.providerProfile.findUnique({
      where: { userId },
    });
    if (
      current?.verification === ProviderVerificationStatus.rejected &&
      current.rejectedAt
    ) {
      const eligibleAt = new Date(
        current.rejectedAt.getTime() + 30 * 24 * 60 * 60 * 1000,
      );
      if (new Date() < eligibleAt)
        throw new ConflictException(
          `You can resubmit on ${eligibleAt.toISOString()}.`,
        );
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const live = await tx.providerProfile.findUnique({ where: { userId } });
      const approved =
        live?.verification === ProviderVerificationStatus.approved;
      const proposed = {
        trade: dto.trade.trim(),
        services: normalized.services,
        serviceAreas: normalized.serviceAreas,
        skills: normalized.skills,
        capacity: dto.capacity,
        documents: dto.documents,
        photo: dto.photo,
      };
      let profile;
      if (approved && live) {
        profile = await tx.providerProfile.update({
          where: { userId },
          data: {
            phone: dto.phone.trim(),
            city: dto.city.trim(),
            experience: dto.experience,
            bio: dto.bio.trim(),
            workingHours: json(dto.workingHours),
            portfolio: json(dto.portfolio ?? []),
            pendingChanges: json({
              ...proposed,
              submittedAt: new Date().toISOString(),
            }),
            changesReview: json({
              state: 'pending',
              note: '',
              at: new Date().toISOString(),
            }),
            version: { increment: 1 },
          },
        });
      } else {
        profile = await tx.providerProfile.upsert({
          where: { userId },
          create: {
            userId,
            phone: dto.phone.trim(),
            trade: dto.trade.trim(),
            city: dto.city.trim(),
            services: json(normalized.services),
            serviceAreas: json(normalized.serviceAreas),
            skills: json(normalized.skills),
            capacity: dto.capacity,
            workingHours: json(dto.workingHours),
            experience: dto.experience,
            bio: dto.bio.trim(),
            documents: json(dto.documents),
            photo: json(dto.photo),
            portfolio: json(dto.portfolio ?? []),
            verification: ProviderVerificationStatus.pending,
            version: 1,
          },
          update: {
            phone: dto.phone.trim(),
            trade: dto.trade.trim(),
            city: dto.city.trim(),
            services: json(normalized.services),
            serviceAreas: json(normalized.serviceAreas),
            skills: json(normalized.skills),
            capacity: dto.capacity,
            workingHours: json(dto.workingHours),
            experience: dto.experience,
            bio: dto.bio.trim(),
            documents: json(dto.documents),
            photo: json(dto.photo),
            portfolio: json(dto.portfolio ?? []),
            verification: ProviderVerificationStatus.pending,
            reviewNote: null,
            rejectedAt: null,
            pendingChanges: Prisma.DbNull,
            changesReview: Prisma.DbNull,
            version: { increment: 1 },
          },
        });
      }

      const pendingBank = await tx.providerBankAccount.findFirst({
        where: { providerId: profile.id, state: ProviderBankStatus.pending },
      });
      const verifiedBank = await tx.providerBankAccount.findFirst({
        where: { providerId: profile.id, state: ProviderBankStatus.verified },
      });
      if (
        pendingBank &&
        (pendingBank.bankCode !== dto.bankCode ||
          decryptSecret(pendingBank.accountNumberEnc) !== dto.accountNumber)
      ) {
        throw new ConflictException(
          'Your previous bank change is still awaiting XPro review.',
        );
      }
      const sameVerifiedBank =
        verifiedBank &&
        verifiedBank.bankCode === dto.bankCode &&
        decryptSecret(verifiedBank.accountNumberEnc) === dto.accountNumber;
      if (!pendingBank && !sameVerifiedBank)
        await tx.providerBankAccount.create({
          data: {
            providerId: profile.id,
            bankCode: dto.bankCode,
            bankName: resolved.bankName,
            accountNumberEnc: encryptSecret(dto.accountNumber),
            accountNameEnc: encryptSecret(resolved.accountName),
            last4: dto.accountNumber.slice(-4),
            state: ProviderBankStatus.pending,
          },
        });
      await tx.providerReview.create({
        data: {
          providerId: profile.id,
          kind: approved ? 'held_change' : 'profile',
          decision: 'submitted',
          actorId: userId,
          version: profile.version,
        },
      });
      const attachmentIds = [
        ...dto.documents.map((file) => file.id),
        dto.photo.id,
        ...(dto.portfolio ?? []).map((file) => file.id),
      ];
      await tx.providerUpload.updateMany({
        where: {
          id: { in: attachmentIds },
          ownerId: userId,
          status: ProviderUploadStatus.ready,
        },
        data: { status: ProviderUploadStatus.attached, attachedAt: new Date() },
      });
      return profile;
    });
    this.audit.record({
      actorType: 'user',
      actorId: userId,
      entityType: 'provider_profile',
      entityId: result.id,
      action: 'provider.submit',
      metadata: { version: result.version },
    });
    return this.myProfile(userId);
  }

  async updateBank(userId: string, dto: ProviderBankUpdateDto) {
    await this.requireProvider(userId);
    const profile = await this.prisma.providerProfile.findUnique({
      where: { userId },
    });
    if (!profile)
      throw new ConflictException(
        'Complete your provider profile before changing bank details.',
      );
    const pending = await this.prisma.providerBankAccount.findFirst({
      where: { providerId: profile.id, state: ProviderBankStatus.pending },
    });
    if (pending)
      throw new ConflictException(
        'Your previous bank change is still awaiting XPro review.',
      );
    const resolved = await this.resolveBank(dto.bankCode, dto.accountNumber);
    const current = await this.prisma.providerBankAccount.findFirst({
      where: { providerId: profile.id, state: ProviderBankStatus.verified },
    });
    if (
      current &&
      current.bankCode === dto.bankCode &&
      decryptSecret(current.accountNumberEnc) === dto.accountNumber
    )
      throw new ConflictException('These are already your payout details.');
    await this.prisma.providerBankAccount.create({
      data: {
        providerId: profile.id,
        bankCode: dto.bankCode,
        bankName: resolved.bankName,
        accountNumberEnc: encryptSecret(dto.accountNumber),
        accountNameEnc: encryptSecret(resolved.accountName),
        last4: dto.accountNumber.slice(-4),
        state: ProviderBankStatus.pending,
      },
    });
    this.audit.record({
      actorType: 'user',
      actorId: userId,
      entityType: 'provider_profile',
      entityId: profile.id,
      action: 'provider.bank.submit',
      metadata: { bankCode: dto.bankCode, last4: dto.accountNumber.slice(-4) },
    });
    return this.myProfile(userId);
  }

  async setAvailability(userId: string, dto: ProviderAvailabilityDto) {
    const profile = await this.prisma.providerProfile.findUnique({
      where: { userId },
    });
    if (!profile)
      throw new ConflictException(
        'Submit your provider profile before changing availability.',
      );
    if (
      dto.available &&
      profile.verification !== ProviderVerificationStatus.approved
    )
      throw new ConflictException(
        'Your profile must be approved before you can change availability.',
      );
    const updated = await this.prisma.providerProfile.update({
      where: { userId },
      data: { available: dto.available, version: { increment: 1 } },
    });
    this.audit.record({
      actorType: 'user',
      actorId: userId,
      entityType: 'provider_profile',
      entityId: updated.id,
      action: 'provider.availability',
      metadata: { available: dto.available },
    });
    return this.myProfile(userId);
  }

  async setCalendar(userId: string, dto: ProviderCalendarDto) {
    const profile = await this.prisma.providerProfile.findUnique({
      where: { userId },
    });
    if (!profile)
      throw new ConflictException(
        'Submit your provider profile before setting working hours.',
      );
    this.validateCalendar(dto.workingHours, dto.timeOff ?? []);
    const updated = await this.prisma.providerProfile.update({
      where: { userId },
      data: {
        workingHours: json(dto.workingHours),
        timeOff: json(dto.timeOff ?? []),
        version: { increment: 1 },
      },
    });
    this.audit.record({
      actorType: 'user',
      actorId: userId,
      entityType: 'provider_profile',
      entityId: updated.id,
      action: 'provider.calendar',
      metadata: { version: updated.version },
    });
    return this.myProfile(userId);
  }

  async listForReview(userId: string, query: ProviderListQueryDto) {
    let providerReview = false;
    let bankReview = false;
    try {
      await this.requirePermission(userId, 'provider.review');
      providerReview = true;
    } catch {
      providerReview = false;
    }
    try {
      await this.requirePermission(userId, 'bank.review');
      bankReview = true;
    } catch {
      bankReview = false;
    }
    if (!providerReview && !bankReview)
      throw new ForbiddenException(
        'You do not have permission to review provider details.',
      );
    const rows = await this.prisma.providerProfile.findMany({
      where: {
        ...(query.verification
          ? { verification: query.verification as ProviderVerificationStatus }
          : {}),
        ...(!providerReview && bankReview
          ? { bankAccounts: { some: { state: ProviderBankStatus.pending } } }
          : {}),
      },
      include: {
        user: { select: { firstName: true, lastName: true, email: true } },
        bankAccounts: { where: { state: ProviderBankStatus.pending } },
      },
      orderBy: { updatedAt: 'asc' },
    });
    return rows.map((row) => {
      const payout = this.project(row, false, bankReview).payout;
      if (!providerReview) {
        return {
          id: row.id,
          userId: row.userId,
          firstName: row.user.firstName,
          lastName: row.user.lastName,
          email: row.user.email,
          trade: row.trade,
          city: row.city,
          verification: row.verification,
          available: row.available,
          version: row.version,
          payout,
        };
      }
      return {
        ...this.project(row, false, bankReview),
        firstName: row.user.firstName,
        lastName: row.user.lastName,
        email: row.user.email,
      };
    });
  }

  async reviewProfile(
    reviewerId: string,
    providerId: string,
    dto: ProviderReviewDto,
  ) {
    await this.requirePermission(reviewerId, 'provider.review');
    const profile = await this.prisma.providerProfile.findUnique({
      where: { id: providerId },
    });
    if (!profile) throw new NotFoundException('Provider profile not found.');
    if (
      profile.version !== dto.expectedVersion ||
      profile.verification !== ProviderVerificationStatus.pending
    )
      throw new ConflictException(
        'This review has already changed. Refresh and try again.',
      );
    if (dto.decision !== 'approved' && !dto.note?.trim())
      throw new BadRequestException(
        'Explain the requested changes or rejection.',
      );
    const updated = await this.prisma.providerProfile.update({
      where: { id: providerId },
      data: {
        verification: dto.decision,
        reviewNote: dto.note?.trim() || null,
        reviewedAt: new Date(),
        reviewedBy: reviewerId,
        rejectedAt: dto.decision === 'rejected' ? new Date() : null,
        version: { increment: 1 },
      },
    });
    await this.prisma.providerReview.create({
      data: {
        providerId,
        kind: 'profile',
        decision: dto.decision,
        note: dto.note?.trim(),
        actorId: reviewerId,
        version: updated.version,
      },
    });
    this.audit.record({
      actorType: 'user',
      actorId: reviewerId,
      entityType: 'provider_profile',
      entityId: providerId,
      action: `provider.review.${dto.decision}`,
      metadata: { version: updated.version, note: dto.note?.trim() },
    });
    return this.project(updated, false);
  }

  async reviewChanges(
    reviewerId: string,
    providerId: string,
    dto: ProviderChangesReviewDto,
  ) {
    await this.requirePermission(reviewerId, 'provider.review');
    const profile = await this.prisma.providerProfile.findUnique({
      where: { id: providerId },
    });
    if (
      !profile ||
      profile.version !== dto.expectedVersion ||
      !profile.pendingChanges
    )
      throw new ConflictException(
        'These profile changes are no longer awaiting review.',
      );
    const changes = profile.pendingChanges as Prisma.JsonObject;
    const now = new Date().toISOString();
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.providerProfile.update({
        where: { id: providerId },
        data: {
          ...(dto.approve
            ? {
                trade: String(changes.trade),
                services: json(changes.services),
                serviceAreas: json(changes.serviceAreas),
                skills: json(changes.skills),
                capacity: Number(changes.capacity),
                documents: json(changes.documents),
                photo: json(changes.photo),
              }
            : {}),
          pendingChanges: Prisma.DbNull,
          changesReview: json({
            state: dto.approve ? 'approved' : 'rejected',
            note: dto.note.trim(),
            at: now,
            by: reviewerId,
          }),
          version: { increment: 1 },
        },
      });
      await tx.providerReview.create({
        data: {
          providerId,
          kind: 'held_change',
          decision: dto.approve ? 'approved' : 'rejected',
          note: dto.note.trim(),
          actorId: reviewerId,
          version: result.version,
        },
      });
      return result;
    });
    this.audit.record({
      actorType: 'user',
      actorId: reviewerId,
      entityType: 'provider_profile',
      entityId: providerId,
      action: dto.approve
        ? 'provider.changes.approve'
        : 'provider.changes.reject',
      metadata: { version: updated.version, note: dto.note.trim() },
    });
    return this.myProfileById(reviewerId, providerId);
  }

  async reviewBank(
    reviewerId: string,
    providerId: string,
    dto: ProviderBankReviewDto,
  ) {
    await this.requirePermission(reviewerId, 'bank.review');
    const profile = await this.prisma.providerProfile.findUnique({
      where: { id: providerId },
    });
    if (!profile || profile.version !== dto.expectedVersion)
      throw new ConflictException(
        'This review has already changed. Refresh and try again.',
      );
    const pending = await this.prisma.providerBankAccount.findFirst({
      where: { providerId, state: ProviderBankStatus.pending },
    });
    if (!pending)
      throw new ConflictException(
        'These bank details are not awaiting review.',
      );
    await this.prisma.$transaction(async (tx) => {
      if (dto.approve) {
        await tx.providerBankAccount.updateMany({
          where: { providerId, state: ProviderBankStatus.verified },
          data: { state: ProviderBankStatus.superseded },
        });
      }
      await tx.providerBankAccount.update({
        where: { id: pending.id },
        data: {
          state: dto.approve
            ? ProviderBankStatus.verified
            : ProviderBankStatus.rejected,
          reviewNote: dto.note.trim(),
          reviewedBy: reviewerId,
          reviewedAt: new Date(),
        },
      });
      await tx.providerProfile.update({
        where: { id: providerId },
        data: { version: { increment: 1 } },
      });
      await tx.providerReview.create({
        data: {
          providerId,
          kind: 'bank',
          decision: dto.approve ? 'approved' : 'rejected',
          note: dto.note.trim(),
          actorId: reviewerId,
          version: profile.version + 1,
        },
      });
    });
    this.audit.record({
      actorType: 'user',
      actorId: reviewerId,
      entityType: 'provider_bank_account',
      entityId: pending.id,
      action: dto.approve ? 'provider.bank.approve' : 'provider.bank.reject',
      metadata: { providerId, note: dto.note.trim(), last4: pending.last4 },
    });
    return this.myProfileById(reviewerId, providerId);
  }

  private async myProfileById(_actorId: string, providerId: string) {
    const profile = await this.prisma.providerProfile.findUnique({
      where: { id: providerId },
      include: {
        bankAccounts: { orderBy: { createdAt: 'desc' } },
        reviews: { orderBy: { createdAt: 'desc' } },
      },
    });
    if (!profile) throw new NotFoundException('Provider profile not found.');
    return this.project(profile, false);
  }

  private async requireProvider(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        status: 'active',
        platformRoles: { some: { role: 'provider' } },
      },
      select: { id: true, emailVerifiedAt: true },
    });
    if (!user)
      throw new ForbiddenException('An active provider account is required.');
    return user;
  }

  private async requirePermission(userId: string, permission: string) {
    const member = await this.prisma.staffMember.findFirst({
      where: { userId, status: StaffStatus.active },
      include: { roles: true },
    });
    const roles = member?.roles.map(({ role }) => role) ?? [];
    if (
      !member ||
      !permissionsForRoles(roles).includes(permission as StaffPermission)
    )
      throw new ForbiddenException(
        'You do not have permission to review provider details.',
      );
    return roles;
  }

  private validateSubmission(dto: ProviderProfileSubmissionDto) {
    if (!dto.services.length)
      throw new BadRequestException('Choose at least one service.');
    if (!dto.serviceAreas.length)
      throw new BadRequestException('Add at least one service area.');
    if (!dto.documents.length)
      throw new BadRequestException(
        'Attach at least one verification document.',
      );
    if (
      !dto.photo ||
      !['image/png', 'image/jpeg', 'image/webp'].includes(dto.photo.type)
    )
      throw new BadRequestException('Add a clear face photo.');
    if (!/^\d{10}$/.test(dto.accountNumber))
      throw new BadRequestException('Enter a 10-digit account number.');
    for (const service of dto.services)
      if (!Array.isArray(dto.skills?.[service]) || !dto.skills[service].length)
        throw new BadRequestException(
          `Choose at least one skill for ${service}.`,
        );
    this.validateCalendar(dto.workingHours, []);
    return {
      services: [...new Set(dto.services)],
      serviceAreas: [
        ...new Set(dto.serviceAreas.map((area) => area.trim()).filter(Boolean)),
      ],
      skills: dto.skills,
    };
  }

  private async verifyAttachments(
    userId: string,
    dto: ProviderProfileSubmissionDto,
  ) {
    const expected = [
      ...dto.documents.map((file) => ({
        file,
        purpose: ProviderUploadPurpose.provider_document,
      })),
      { file: dto.photo, purpose: ProviderUploadPurpose.provider_photo },
      ...(dto.portfolio ?? []).map((file) => ({
        file,
        purpose: ProviderUploadPurpose.provider_portfolio,
      })),
    ];
    const ids = expected.map(({ file }) => file.id);
    if (new Set(ids).size !== ids.length)
      throw new BadRequestException('A file can only be attached once.');
    const rows = await this.prisma.providerUpload.findMany({
      where: { id: { in: ids }, ownerId: userId },
    });
    if (rows.length !== ids.length)
      throw new BadRequestException(
        'Upload each verification file before submitting your profile.',
      );
    for (const { file, purpose } of expected) {
      const row = rows.find((item) => item.id === file.id);
      if (
        !row ||
        row.purpose !== purpose ||
        (row.status !== ProviderUploadStatus.ready &&
          row.status !== ProviderUploadStatus.attached)
      )
        throw new BadRequestException(
          'The selected file is not ready to attach. Upload it again.',
        );
      if (
        row.size !== file.size ||
        row.contentType !== file.type ||
        row.fileName !== file.name
      )
        throw new BadRequestException(
          'Uploaded file details do not match. Select the file again.',
        );
    }
  }

  private validateFile(
    name: string,
    type: string,
    size: number,
    purpose: ProviderUploadPurpose,
  ) {
    const ext = name.split('.').pop()?.toLowerCase();
    const allowed: Record<
      ProviderUploadPurpose,
      { extensions: string[]; types: string[] }
    > = {
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
    if (
      !allowed[purpose].extensions.includes(ext ?? '') ||
      !allowed[purpose].types.includes(type)
    )
      throw new BadRequestException(
        'Use a supported file type for this upload.',
      );
    if (
      size > 20 * 1024 * 1024 ||
      (purpose === ProviderUploadPurpose.provider_photo &&
        size > 5 * 1024 * 1024)
    )
      throw new BadRequestException('This file is too large.');
  }

  private hasExpectedSignature(bytes: Buffer, type: string) {
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
    if (type.startsWith('application/vnd.openxmlformats-officedocument'))
      return bytes.subarray(0, 2).toString() === 'PK';
    if (type === 'application/msword')
      return bytes.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
    return false;
  }

  private validateCalendar(
    workingHours: Record<string, { start: string; end: string } | null>,
    timeOff: { from: string; to: string }[],
  ) {
    const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    let open = 0;
    for (const day of days) {
      const interval = workingHours?.[day];
      if (!interval) continue;
      if (
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(interval.start) ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(interval.end) ||
        interval.start >= interval.end
      )
        throw new BadRequestException('Enter valid weekly working hours.');
      open++;
    }
    if (!open)
      throw new BadRequestException(
        'Choose weekly working hours before submitting.',
      );
    for (const item of timeOff) {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(item.from) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(item.to) ||
        item.from > item.to
      )
        throw new BadRequestException('Enter valid time-off dates.');
    }
  }

  private async resolveBank(
    bankCode: string,
    accountNumber: string,
  ): Promise<{ bankName: string; accountName: string }> {
    const secret = this.config.get<string>('PAYSTACK_SECRET_KEY');
    if (!secret)
      throw new ServiceUnavailableException(
        'Bank account verification is not configured.',
      );
    let bankResponse: Response;
    try {
      bankResponse = await fetch(
        'https://api.paystack.co/bank?country=nigeria&perPage=100',
        {
          headers: { Authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(8000),
        },
      );
    } catch {
      throw new ServiceUnavailableException(
        'Bank lookup is temporarily unavailable.',
      );
    }
    if (!bankResponse.ok)
      throw new ServiceUnavailableException(
        'Bank lookup is temporarily unavailable.',
      );
    const bankPayload = (await bankResponse.json()) as {
      data?: { code: string; name: string }[];
    };
    const bankName = bankPayload.data?.find(
      (bank) => bank.code === bankCode,
    )?.name;
    if (!bankName) throw new BadRequestException('Choose a valid bank.');
    let resolveResponse: Response;
    try {
      resolveResponse = await fetch(
        `https://api.paystack.co/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`,
        {
          headers: { Authorization: `Bearer ${secret}` },
          signal: AbortSignal.timeout(8000),
        },
      );
    } catch {
      throw new ServiceUnavailableException(
        'Bank lookup is temporarily unavailable.',
      );
    }
    if (!resolveResponse.ok)
      throw new BadRequestException('We could not verify these bank details.');
    const result = (await resolveResponse.json()) as {
      data?: { account_name?: string; account_number?: string };
    };
    if (
      result.data?.account_number !== accountNumber ||
      !result.data.account_name
    )
      throw new BadRequestException('We could not verify these bank details.');
    return { bankName, accountName: result.data.account_name };
  }

  private project(
    profile: {
      id: string;
      userId: string;
      phone: string;
      trade: string;
      city: string;
      services: Prisma.JsonValue;
      serviceAreas: Prisma.JsonValue;
      skills: Prisma.JsonValue;
      capacity: number;
      workingHours: Prisma.JsonValue;
      timeOff: Prisma.JsonValue;
      experience: number;
      bio: string;
      documents: Prisma.JsonValue;
      photo: Prisma.JsonValue | null;
      portfolio: Prisma.JsonValue;
      verification: ProviderVerificationStatus;
      available: boolean;
      reviewNote: string | null;
      pendingChanges: Prisma.JsonValue;
      changesReview: Prisma.JsonValue;
      version: number;
      bankAccounts?: {
        bankCode: string;
        bankName: string;
        accountNumberEnc: string;
        accountNameEnc: string;
        last4: string;
        state: ProviderBankStatus;
        reviewNote: string | null;
        createdAt: Date;
      }[];
      reviews?: {
        kind: string;
        decision: string;
        note: string | null;
        createdAt: Date;
      }[];
    },
    owner: boolean,
    bankReview = false,
  ) {
    const banks = (profile.bankAccounts ?? []).map((account) => ({
      bankCode: account.bankCode,
      bankName: account.bankName,
      accountNumber: `••••${account.last4}`,
      accountName:
        owner || bankReview ? decryptSecret(account.accountNameEnc) : 'Hidden',
      state: account.state,
      reviewNote: owner ? account.reviewNote : undefined,
      submittedAt: account.createdAt,
    }));
    return {
      id: profile.id,
      userId: profile.userId,
      phone: profile.phone,
      trade: profile.trade,
      city: profile.city,
      services: profile.services,
      serviceAreas: profile.serviceAreas,
      skills: profile.skills,
      capacity: profile.capacity,
      workingHours: profile.workingHours,
      timeOff: profile.timeOff,
      experience: profile.experience,
      bio: profile.bio,
      documents: profile.documents,
      photo: profile.photo,
      portfolio: profile.portfolio,
      verification: profile.verification,
      available: profile.available,
      reviewNote: owner ? profile.reviewNote : undefined,
      pendingChanges: profile.pendingChanges,
      changesReview: profile.changesReview,
      version: profile.version,
      payout: {
        current:
          banks.find((bank) => bank.state === ProviderBankStatus.verified) ??
          null,
        pending:
          banks.find((bank) => bank.state === ProviderBankStatus.pending) ??
          null,
      },
      history: (profile.reviews ?? []).map((review) => ({
        kind: review.kind,
        decision: review.decision,
        note: owner ? review.note : undefined,
        createdAt: review.createdAt,
      })),
    };
  }
}
