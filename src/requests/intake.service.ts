import { ConflictException, Injectable } from '@nestjs/common';
import {
  Prisma,
  RequestStatus,
  UploadPurpose,
  UploadStatus,
} from '@prisma/client';
import type { RequestUser } from '../common/types/request-user';
import { ActorService } from '../platform/actor/actor.service';
import {
  requireCustomer,
  requirePermission,
} from '../platform/actor/actor.guards';
import type { ActorContext } from '../platform/actor/actor.types';
import { AppError } from '../platform/errors/app-error';
import { IdempotencyService } from '../platform/idempotency/idempotency.service';
import { UploadsService } from '../uploads/uploads.service';
import { TimerKinds } from '../platform/timers/timer-kinds';
import { RequestCommandRunner } from './command-runner';
import {
  validateIntake,
  type IntakeValidationInput,
  type ValidatedIntake,
} from './domain/intake-validation';
import type {
  RequestIntakeDto,
  RequestUpdateDto,
} from './dto/request-intake.dto';
import { effectiveDates, jsonObject } from './projections/projection.helpers';
import { REQUEST_INCLUDE, type LoadedRequest } from './snapshot.loader';
import { ApprovalsHooks } from './approvals.hooks';
import {
  canClarify,
  canFreeCancel,
  canReject,
  canReview,
} from './domain/intake-guards';
import type {
  RequestClarifyDto,
  RequestFreeCancelDto,
  RequestRejectDto,
  RequestReviewDto,
} from './dto/request-intake.dto';

const UPDATE_CUSTOMER_WINDOW_MESSAGE =
  'XPro has already approved this request. Send changes to XPro in Messages.';
const UPDATE_STAFF_WINDOW_MESSAGE =
  'A provider has already accepted this request. Agree changes with the customer and reflect them in the quote.';
const OPEN_STATUSES: RequestStatus[] = [
  'submitted',
  'under_review',
  'matched',
  'quoted',
  'awaiting_payment',
  'ready_to_schedule',
  'scheduled',
  'in_progress',
  'blocked',
  'completion_pending',
  'acknowledged',
  'cancelling',
];
const T6_TIMERS = [
  TimerKinds.T6Reminder48h,
  TimerKinds.T6Staff5d,
  TimerKinds.T6FinalWarning,
  TimerKinds.T6AutoCancel,
];

@Injectable()
export class IntakeService {
  constructor(
    private readonly actors: ActorService,
    private readonly runner: RequestCommandRunner,
    private readonly idempotency: IdempotencyService,
    private readonly uploads: UploadsService,
    private readonly approvals: ApprovalsHooks,
  ) {}

  async create(
    user: RequestUser,
    dto: RequestIntakeDto,
    key: string,
    originalUrl: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    this.requireActiveCustomer(actor);
    const hash = this.idempotency.hashRequest('POST', originalUrl, dto);
    let warning: string | undefined;
    let duplicateRef: string | undefined;
    const result = await this.runner.create(
      { actor, idempotencyKey: key, idempotencyHash: hash },
      async (tx, now, settings) => {
        const locations = await tx.location.findMany({
          where: { active: true },
          select: { id: true, kind: true, parentId: true, active: true },
        });
        const valid = validateIntake(dto, undefined, locations, now);
        const possible = await findPossibleDuplicate(tx, user.id, valid, now);
        if (possible) {
          duplicateRef = formatRequestNumber(possible.number);
          warning = `You already have a similar open request (${formatRequestNumber(possible.number)}). XPro will check it isn't a duplicate.`;
        }
        const row = await tx.serviceRequest.create({
          data: {
            ownerId: user.id,
            customerName: actor.displayName,
            title: valid.title,
            service: valid.service,
            cityId: valid.cityId,
            districtId: valid.districtId,
            address: valid.address,
            phone: valid.phone,
            contactMethod: valid.contactMethod,
            description: valid.description,
            budget: BigInt(valid.budget),
            startDate: valid.startDate,
            details: valid.details,
            status: 'submitted',
            intakeState: 'pending',
            version: 1,
            contactInBrief: valid.contactInBrief,
            possibleDuplicateOf: possible?.id,
            dispatchMode: modeForService(settings, valid.service),
            autoAttempts: 0,
            unclaimedSince: now,
          },
        });
        const uploaded = await this.attachUploads(
          tx,
          valid.attachmentIds,
          user.id,
          row.id,
        );
        if (uploaded.length)
          await tx.requestAttachment.createMany({
            data: uploaded.map(({ id }) => ({
              requestId: row.id,
              uploadId: id,
              sharedWithProvider: false,
            })),
          });

        return row.id;
      },
      async (context) => {
        context.audit('Request submitted', {
          flags: warning ? ['possible_duplicate'] : [],
          changes: duplicateRef
            ? { possibleDuplicateOf: duplicateRef }
            : undefined,
        });
        const requestCode = context.snap.number;
        context.notify('request.received', { requestCode });
        context.notify('request.submitted', { requestCode });
        // The 02 approval queue owns these deadlines. WP-9 installs the hook that creates them.
        await this.approvals.onSubmitted(
          context.tx,
          context.snap.id,
          context.now,
        );
        return { status: 201, ...(warning ? { warning } : {}) };
      },
    );
    return result;
  }

  async update(
    user: RequestUser,
    ref: string,
    dto: RequestUpdateDto,
    version: number,
    originalUrl: string,
    idempotencyKey?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    const hash = this.idempotency.hashRequest('PUT', originalUrl, dto);
    const result = await this.runner.run(
      {
        command: 'request.update',
        actor,
        requestRef: ref,
        expectedVersion: version,
        autoClaim: true,
        ...(idempotencyKey ? { idempotencyKey, idempotencyHash: hash } : {}),
      },
      async (context) => {
        const row = await context.tx.serviceRequest.findUnique({
          where: { id: context.snap.id },
          include: REQUEST_INCLUDE,
        });
        if (!row) throw this.notFound();
        const isOwner =
          actor.userId === row.ownerId &&
          actor.platformRoles.includes('customer');
        const isStaff = actor.kind === 'staff';
        if (isOwner) {
          if (
            row.status !== 'submitted' ||
            (row.intakeState !== 'pending' &&
              row.intakeState !== 'clarification')
          )
            throw new AppError(
              409,
              'STATE_CONFLICT',
              UPDATE_CUSTOMER_WINDOW_MESSAGE,
            );
        } else if (isStaff) {
          requirePermission(actor, 'request.review');
          if (
            (row.status !== 'submitted' && row.status !== 'under_review') ||
            row.assignments.some(
              ({ status }) =>
                status === 'pending_approval' || status === 'accepted',
            ) ||
            row.quotes.some(({ status }) => status === 'accepted')
          )
            throw new AppError(
              409,
              'STATE_CONFLICT',
              UPDATE_STAFF_WINDOW_MESSAGE,
            );
          if (typeof dto.note !== 'string' || !dto.note.trim())
            throw new AppError(
              422,
              'VALIDATION_ERROR',
              'Add a note explaining the change.',
            );
        } else {
          throw new AppError(
            403,
            'FORBIDDEN',
            'This action is not available for your account type.',
          );
        }

        if (
          isStaff &&
          (dto.phone !== undefined ||
            dto.address !== undefined ||
            dto.contactMethod !== undefined) &&
          !actor.staff?.permissions.has('view.customer_contact')
        )
          throw new AppError(
            403,
            'FORBIDDEN',
            'Your staff role does not allow this action.',
          );

        const oldDetails = jsonObject(row.details);
        const service = dto.service ?? row.service;
        const detailsInput =
          dto.details !== undefined
            ? dto.details
            : service === row.service
              ? oldDetails
              : {};
        const input: IntakeValidationInput = {
          title: dto.title ?? row.title,
          service,
          cityId: dto.cityId ?? row.cityId,
          districtId: dto.districtId ?? row.districtId,
          address: dto.address ?? row.address,
          phone: dto.phone ?? row.phone,
          contactMethod: dto.contactMethod ?? row.contactMethod,
          description: dto.description ?? row.description,
          budget: dto.budget ?? Number(row.budget),
          startDate: dto.startDate ?? row.startDate ?? undefined,
          details: detailsInput,
          preferredProviderId: dto.preferredProviderId,
          providerId: dto.providerId,
          attachments: [],
        };
        const locations = await context.tx.location.findMany({
          where: { active: true },
          select: { id: true, kind: true, parentId: true, active: true },
        });
        const valid = validateIntake(input, undefined, locations, context.now);
        if (dto.attachments !== undefined && !Array.isArray(dto.attachments))
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            "One of your files didn't finish uploading. Remove it and try again.",
          );
        const attachmentIds =
          dto.attachments === undefined
            ? row.attachments.map(({ uploadId }) => uploadId)
            : dto.attachments.map((item) =>
                item && typeof item.id === 'string' ? item.id : '',
              );
        if (
          attachmentIds.some((id) => !id) ||
          new Set(attachmentIds).size !== attachmentIds.length
        )
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            "One of your files didn't finish uploading. Remove it and try again.",
          );
        if (attachmentIds.length > 20)
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'A request can hold up to 20 files. Remove one before adding more.',
          );

        const data: Prisma.ServiceRequestUpdateInput = {
          title: valid.title,
          service: valid.service,
          cityId: valid.cityId,
          districtId: valid.districtId,
          address: valid.address,
          phone: valid.phone,
          contactMethod: valid.contactMethod,
          description: valid.description,
          budget: BigInt(valid.budget),
          startDate: valid.startDate,
          details: valid.details,
          contactInBrief: valid.contactInBrief,
        };
        const changedFields = changedRequestFields(
          row,
          data,
          oldDetails,
          valid.details,
        );
        const newIds = attachmentIds.filter(
          (id) => !row.attachments.some(({ uploadId }) => uploadId === id),
        );
        const removedIds = row.attachments
          .map(({ uploadId }) => uploadId)
          .filter((id) => !attachmentIds.includes(id));
        if (newIds.length || removedIds.length)
          changedFields.push('attachments');
        if (newIds.length)
          await this.attachUploads(context.tx, newIds, user.id, row.id);
        if (removedIds.length) {
          await context.tx.requestAttachment.deleteMany({
            where: { requestId: row.id, uploadId: { in: removedIds } },
          });
          await context.tx.upload.updateMany({
            where: {
              id: { in: removedIds },
              ownerId: row.ownerId,
              status: UploadStatus.attached,
              entityType: 'service_request',
              entityId: row.id,
            },
            data: {
              status: UploadStatus.ready,
              entityType: null,
              entityId: null,
              attachedAt: null,
            },
          });
        }
        if (newIds.length) {
          await context.tx.requestAttachment.createMany({
            data: newIds.map((uploadId) => ({
              requestId: row.id,
              uploadId,
              sharedWithProvider: false,
            })),
          });
        }
        const keyChanged = hasKeyFieldChanged(row, valid, oldDetails);
        const offered = row.assignments.find(
          ({ status }) => status === 'offered',
        );
        if (keyChanged && offered) {
          await context.tx.assignment.update({
            where: { id: offered.id },
            data: {
              status: 'withdrawn',
              endReason: 'request_edited',
              endedAt: context.now,
              endedBy: user.id,
            },
          });
          context.timers.stop(
            [TimerKinds.T1Reminder, TimerKinds.T1Expire],
            offered.id,
          );
          context.audit('Offer withdrawn (request changed)', {
            resourceType: 'assignment',
            resourceId: offered.id,
            changes: { endReason: 'request_edited' },
          });
          context.notify('request.offer_withdrawn', {
            assignmentId: offered.id,
            requestCode: context.snap.number,
            service: valid.service,
            district: context.snap.districtName ?? 'your area',
          });
        }
        const settingsMode = row.dispatchMode;
        const rerun =
          keyChanged &&
          (Boolean(offered) ||
            (row.intakeState === 'approved' &&
              context.snap.currentAssignment === null &&
              row.needsAssignmentReason === 'no_eligible'));
        if (rerun && settingsMode === 'auto') context.enqueueCascade('edited');
        if (rerun && settingsMode === 'manual')
          await context.tx.serviceRequest.update({
            where: { id: row.id },
            data: { needsAssignmentReason: 'edited' },
          });

        if (
          changedFields.length === 0 &&
          !(isOwner && row.intakeState === 'clarification')
        )
          return { changed: false };
        await context.tx.serviceRequest.update({ where: { id: row.id }, data });
        for (const field of changedFields) {
          const oldValue = valueForField(row, field, oldDetails);
          const newValue =
            field === 'attachments'
              ? attachmentIds
              : valueForField(
                  { ...row, ...data } as LoadedRequest,
                  field,
                  valid.details,
                );
          await context.tx.requestEdit.create({
            data: {
              requestId: row.id,
              field,
              oldValue: jsonValue(oldValue),
              newValue: jsonValue(newValue),
              byId: user.id,
              byRole: isStaff ? 'staff' : 'customer',
              note: dto.note?.trim() || null,
              redispatched: keyChanged && Boolean(offered),
            },
          });
        }
        if (isOwner && row.intakeState === 'clarification') {
          await context.tx.serviceRequest.update({
            where: { id: row.id },
            data: { intakeState: 'pending' },
          });
          context.timers.stop([
            TimerKinds.T6Reminder48h,
            TimerKinds.T6Staff5d,
            TimerKinds.T6FinalWarning,
            TimerKinds.T6AutoCancel,
          ]);
          context.audit('Clarification answered');
          context.notify('request.clarification_answered', {
            requestCode: context.snap.number,
          });
        }
        context.audit('Request updated', {
          changes: { fields: changedFields },
        });
        context.notify(
          isStaff ? 'request.updated_by_staff' : 'request.updated_by_customer',
          {
            requestCode: context.snap.number,
            fields: changedFields.map(fieldLabel),
          },
        );
        return {};
      },
    );
    return result;
  }

  async clarify(
    user: RequestUser,
    ref: string,
    dto: RequestClarifyDto,
    version: number,
    originalUrl: string,
    idempotencyKey?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    requirePermission(
      actor,
      actor.staff?.permissions.has('request.clarify')
        ? 'request.clarify'
        : 'request.review',
    );
    const hash = this.idempotency.hashRequest('POST', originalUrl, dto);
    return this.runner.run(
      {
        command: 'request.clarify',
        actor,
        requestRef: ref,
        expectedVersion: version,
        autoClaim: true,
        ...(idempotencyKey ? { idempotencyKey, idempotencyHash: hash } : {}),
      },
      async (context) => {
        assertGuard(
          canClarify(
            context.snap,
            actorView(actor),
            undefined,
            context.now,
            context.settings,
          ),
        );
        const question =
          typeof dto.question === 'string' ? dto.question.trim() : '';
        if (question.length < 5 || question.length > 1000)
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'Add the clarification you need from the customer.',
          );
        await context.tx.requestMessage.create({
          data: {
            requestId: context.snap.id,
            channel: 'customer',
            authorId: actor.userId,
            authorRole: 'staff',
            text: question,
          },
        });
        const clarificationAskedAt = context.now;
        await context.tx.serviceRequest.update({
          where: { id: context.snap.id },
          data: {
            intakeState: 'clarification',
            clarificationAskedAt,
            clarificationCount: { increment: 1 },
          },
        });
        await this.approvals.close(context.tx, 'intake', context.snap.id, context.now);
        await this.approvals.open(context.tx, 'clarification_overdue', context.snap.id, context.snap.id, context.now, actor.userId);
        context.timers.stop(T6_TIMERS);
        context.timers.start(
          TimerKinds.T6Reminder48h,
          addDays(clarificationAskedAt, 2),
          undefined,
          { clarificationAskedAt: clarificationAskedAt.toISOString() },
        );
        context.timers.start(
          TimerKinds.T6Staff5d,
          addDays(clarificationAskedAt, 5),
          undefined,
          { clarificationAskedAt: clarificationAskedAt.toISOString() },
        );
        context.timers.start(
          TimerKinds.T6FinalWarning,
          addDays(clarificationAskedAt, 13),
          undefined,
          { clarificationAskedAt: clarificationAskedAt.toISOString() },
        );
        context.timers.start(
          TimerKinds.T6AutoCancel,
          addDays(clarificationAskedAt, 14),
          undefined,
          { clarificationAskedAt: clarificationAskedAt.toISOString() },
        );
        context.audit('Clarification requested', { note: question });
        context.notify('request.clarification_requested', {
          requestCode: context.snap.number,
        });
        return {};
      },
    );
  }

  async review(
    user: RequestUser,
    ref: string,
    dto: RequestReviewDto,
    version: number,
    originalUrl: string,
    idempotencyKey?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    requirePermission(actor, 'request.review');
    const hash = this.idempotency.hashRequest('POST', originalUrl, dto);
    return this.runner.run(
      {
        command: 'request.review',
        actor,
        requestRef: ref,
        expectedVersion: version,
        autoClaim: true,
        ...(idempotencyKey ? { idempotencyKey, idempotencyHash: hash } : {}),
      },
      async (context) => {
        assertGuard(
          canReview(
            context.snap,
            actorView(actor),
            undefined,
            context.now,
            context.settings,
          ),
        );
        const row = await context.tx.serviceRequest.findUnique({
          where: { id: context.snap.id },
          include: REQUEST_INCLUDE,
        });
        if (!row) throw this.notFound();
        const offerBrief =
          typeof dto.offerBrief === 'string' ? dto.offerBrief.trim() : '';
        if (offerBrief.length < 20 || offerBrief.length > 1000)
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'Write the brief providers will see in the offer (at least 20 characters).',
          );
        if (row.contactInBrief && dto.contactCheck !== true)
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'Confirm the offer brief contains no phone numbers, email addresses or site access details.',
          );
        const shareOnConfirm = dto.shareOnConfirm ?? {
          description: true,
          attachmentIds: [],
        };
        if (
          !shareOnConfirm ||
          typeof shareOnConfirm.description !== 'boolean' ||
          !Array.isArray(shareOnConfirm.attachmentIds) ||
          shareOnConfirm.attachmentIds.some((id) => typeof id !== 'string') ||
          new Set(shareOnConfirm.attachmentIds).size !==
            shareOnConfirm.attachmentIds.length ||
          shareOnConfirm.attachmentIds.some(
            (id) =>
              !row.attachments.some((attachment) => attachment.uploadId === id),
          )
        )
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'Choose only files attached to this request to share with the provider.',
          );
        const mode = modeForService(context.settings, row.service);
        await context.tx.serviceRequest.update({
          where: { id: row.id },
          data: {
            intakeState: 'approved',
            status: 'under_review',
            intakeApprovedBy: actor.userId,
            intakeApprovedAt: context.now,
            offerBrief,
            shareOnConfirm: shareOnConfirm as Prisma.InputJsonValue,
            dispatchMode: mode,
            autoAttempts: 0,
            ...(mode === 'manual'
              ? { needsAssignmentReason: 'manual_mode' }
              : { needsAssignmentReason: null }),
          },
        });
        await this.approvals.close(context.tx, 'intake', row.id, context.now);
        await this.approvals.close(context.tx, 'clarification_overdue', row.id, context.now);
        context.timers.stop(T6_TIMERS);
        if (mode === 'auto') context.enqueueCascade('intake_approved');
        else
          context.notify('request.needs_manual_assignment', {
            requestCode: context.snap.number,
          });
        context.audit('Intake approved', { note: offerBrief });
        context.notify('request.approved', {
          requestCode: context.snap.number,
        });
        return {};
      },
    );
  }

  async reject(
    user: RequestUser,
    ref: string,
    dto: RequestRejectDto,
    version: number,
    originalUrl: string,
    idempotencyKey?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    requirePermission(actor, 'request.review');
    const hash = this.idempotency.hashRequest('POST', originalUrl, dto);
    return this.runner.run(
      {
        command: 'request.reject',
        actor,
        requestRef: ref,
        expectedVersion: version,
        ...(idempotencyKey ? { idempotencyKey, idempotencyHash: hash } : {}),
      },
      async (context) => {
        assertGuard(
          canReject(
            context.snap,
            actorView(actor),
            undefined,
            context.now,
            context.settings,
          ),
        );
        const reason = typeof dto.reason === 'string' ? dto.reason.trim() : '';
        if (reason.length < 5 || reason.length > 1000)
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            'Add a reason for rejecting this request.',
          );
        await context.tx.serviceRequest.update({
          where: { id: context.snap.id },
          data: { status: 'rejected' },
        });
        await context.tx.requestMessage.create({
          data: {
            requestId: context.snap.id,
            channel: 'customer',
            authorId: actor.userId,
            authorRole: 'staff',
            text: `Not accepted: ${reason}`,
          },
        });
        context.timers.stop(T6_TIMERS);
        context.audit('Request rejected', { note: reason });
        context.notify('request.rejected', {
          requestCode: context.snap.number,
          reason,
        });
        return {};
      },
    );
  }

  async freeCancel(
    user: RequestUser,
    ref: string,
    dto: RequestFreeCancelDto,
    version: number,
    originalUrl: string,
    idempotencyKey?: string,
  ) {
    const actor = await this.actors.resolve(user.id);
    this.requireActiveCustomer(actor);
    const note = typeof dto.note === 'string' ? dto.note.trim() : '';
    if (!note)
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'Add a reason for cancelling this request.',
      );
    const hash = this.idempotency.hashRequest('POST', originalUrl, dto);
    return this.runner.run(
      {
        command: 'request.cancel',
        actor,
        requestRef: ref,
        expectedVersion: version,
        ...(idempotencyKey ? { idempotencyKey, idempotencyHash: hash } : {}),
      },
      async (context) => {
        assertGuard(
          canFreeCancel(
            context.snap,
            actorView(actor),
            undefined,
            context.now,
            context.settings,
          ),
        );
        await context.tx.serviceRequest.update({
          where: { id: context.snap.id },
          data: { status: 'cancelled' },
        });
        const cancellation = await context.tx.cancellation.create({
          data: {
            requestId: context.snap.id,
            status: 'completed',
            requestedBy: 'customer',
            requestedById: actor.userId,
            reasonCode: 'customer_changed_mind',
            note,
            stage: 'submitted',
          },
        });
        await context.tx.serviceRequest.update({
          where: { id: context.snap.id },
          data: { cancellationId: cancellation.id },
        });
        context.timers.stop(T6_TIMERS);
        context.audit('Request cancelled', {
          note,
          changes: { reasonCode: 'customer_changed_mind' },
        });
        return {};
      },
    );
  }

  private requireActiveCustomer(actor: ActorContext) {
    requireCustomer(actor);
    if (!actor.accountActive)
      throw new AppError(
        403,
        'FORBIDDEN',
        'This action is not available for your account type.',
      );
  }

  private async attachUploads(
    tx: Prisma.TransactionClient,
    ids: string[],
    ownerId: string,
    requestId: string,
  ) {
    if (!ids.length) return [];
    const uploads = await tx.upload.findMany({
      where: {
        id: { in: ids },
        ownerId,
        purpose: UploadPurpose.request_attachment,
        status: UploadStatus.ready,
      },
    });
    if (uploads.length !== ids.length)
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        "One of your files didn't finish uploading. Remove it and try again.",
      );
    if (
      uploads.reduce((sum, upload) => sum + upload.size, 0) >
      25 * 1024 * 1024
    )
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'Keep the combined file size under 25 MB.',
      );
    const attached = [];
    for (let start = 0; start < ids.length; start += 6) {
      try {
        attached.push(
          ...(await this.uploads.attach(
            tx,
            ids.slice(start, start + 6),
            ownerId,
            UploadPurpose.request_attachment,
            'service_request',
            requestId,
          )),
        );
      } catch (error) {
        if (error instanceof ConflictException)
          throw new AppError(
            422,
            'VALIDATION_ERROR',
            "One of your files didn't finish uploading. Remove it and try again.",
          );
        throw error;
      }
    }
    return attached;
  }

  private notFound() {
    return new AppError(
      404,
      'NOT_FOUND',
      'This request is no longer available to your account.',
    );
  }
}

function actorView(actor: ActorContext) {
  return {
    kind: actor.kind,
    userId: actor.userId,
    permissions: actor.staff?.permissions,
  } as const;
}

function assertGuard(
  result: ReturnType<typeof canReview>,
): asserts result is { ok: true } {
  if (!result.ok)
    throw new AppError(result.status, result.code, result.message);
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function modeForService(
  settings: Readonly<Record<string, unknown>>,
  service: string,
): 'auto' | 'manual' {
  const byService = settings['assignment.modeByService'];
  if (byService && typeof byService === 'object' && !Array.isArray(byService))
    return (byService as Record<string, unknown>)[service] === 'manual'
      ? 'manual'
      : 'auto';
  return 'auto';
}

async function findPossibleDuplicate(
  tx: Prisma.TransactionClient,
  ownerId: string,
  intake: ValidatedIntake,
  now: Date,
) {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const candidates = await tx.serviceRequest.findMany({
    where: {
      ownerId,
      service: intake.service,
      districtId: intake.districtId,
      status: { in: OPEN_STATUSES },
      createdAt: { gte: since },
    },
    select: { id: true, number: true, title: true },
    orderBy: { createdAt: 'desc' },
  });
  return (
    candidates.find(
      ({ title }) => trigramSimilarity(intake.title, title) >= 0.6,
    ) ?? null
  );
}

export function trigramSimilarity(left: string, right: string): number {
  const a = titleTrigrams(left);
  const b = titleTrigrams(right);
  if (a.size === 0 || b.size === 0) return 0;
  let common = 0;
  for (const trigram of a) if (b.has(trigram)) common++;
  return common / Math.max(a.size, b.size);
}

function titleTrigrams(value: string): Set<string> {
  const words = value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const trigrams = new Set<string>();
  for (const word of words) {
    const padded = `  ${word} `;
    for (let index = 0; index <= padded.length - 3; index++)
      trigrams.add(padded.slice(index, index + 3));
  }
  return trigrams;
}

function formatRequestNumber(number: number): string {
  return `XPR-${String(number).padStart(5, '0')}`;
}

function fieldLabel(field: string): string {
  const labels: Record<string, string> = {
    title: 'title',
    service: 'service',
    cityId: 'city',
    districtId: 'district',
    address: 'site address',
    phone: 'phone',
    contactMethod: 'contact method',
    description: 'project brief',
    budget: 'budget',
    startDate: 'start date',
    details: 'intake details',
    attachments: 'attachments',
  };
  return labels[field] ?? field;
}

function changedRequestFields(
  row: LoadedRequest,
  data: Prisma.ServiceRequestUpdateInput,
  oldDetails: Record<string, unknown>,
  nextDetails: Record<string, unknown>,
): string[] {
  const fields: string[] = [];
  for (const field of [
    'title',
    'service',
    'cityId',
    'districtId',
    'address',
    'phone',
    'contactMethod',
    'description',
    'budget',
    'startDate',
  ] as const) {
    const next = data[field];
    const previous = row[field];
    if (
      next !== undefined &&
      JSON.stringify(previous ?? null) !== JSON.stringify(next ?? null)
    )
      fields.push(field);
  }
  if (JSON.stringify(oldDetails) !== JSON.stringify(nextDetails))
    fields.push('details');
  return fields;
}

function hasKeyFieldChanged(
  row: LoadedRequest,
  valid: ValidatedIntake,
  oldDetails: Record<string, unknown>,
): boolean {
  const oldDates = effectiveDates(row.service, row.startDate, oldDetails);
  const skillKeys: Record<string, string> = {
    Design: 'designType',
    Construction: 'workType',
    Hire: 'trade',
    Procurement: 'category',
    'Facility management': 'serviceNeeds',
    'Waste management': 'wasteType',
  };
  return (
    row.service !== valid.service ||
    row.cityId !== valid.cityId ||
    row.districtId !== valid.districtId ||
    oldDetails[skillKeys[row.service]] !==
      valid.details[skillKeys[valid.service]] ||
    oldDates.effectiveStartDate !== valid.effectiveStartDate ||
    (row.service === 'Hire' &&
      oldDates.effectiveEndDate !== valid.effectiveEndDate)
  );
}

function valueForField(
  row: LoadedRequest,
  field: string,
  details: Record<string, unknown>,
): unknown {
  if (field === 'details') return details;
  if (field === 'attachments')
    return row.attachments.map(({ uploadId }) => uploadId);
  const value = (row as unknown as Record<string, unknown>)[field];
  return typeof value === 'bigint' ? Number(value) : value;
}

function jsonValue(
  value: unknown,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (value === undefined || value === null) return Prisma.JsonNull;
  if (typeof value === 'bigint') return Number(value);
  return value;
}
