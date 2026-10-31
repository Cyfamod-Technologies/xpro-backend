import { Injectable } from '@nestjs/common';
import {
  MessageKind,
  Prisma,
  ProviderVerificationStatus,
  RequestActivityKind,
  RequestDecisionOutcome,
  RequestStatus,
  RequestWorkflow,
  UploadPurpose,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { formatRequestId, parseRequestId } from '../requests/domain/statuses';
import { ActorService } from '../platform/actor/actor.service';
import type { ActorContext } from '../platform/actor/actor.types';
import { AppError } from '../platform/errors/app-error';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../platform/settings/settings.service';
import { UploadsService } from '../uploads/uploads.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { IdempotencyService } from '../platform/idempotency/idempotency.service';
import {
  evaluateOpenRequestLimit,
  platformOpenRequestLimit,
} from '../requests/domain/open-request-limit';
import { normalizeNigerianPhone } from '../requests/domain/intake-validation';
import {
  V1ApproveDto,
  V1AssignStaffDto,
  V1CreateRequestDto,
  V1DenyDto,
  V1ListRequestsQueryDto,
  V1ReplaceProviderDto,
  V1SendMessageDto,
} from './v1.dto';

const requestInclude = {
  decision: { include: { provider: { include: { user: true } } } },
  providerAssignments: {
    where: { endedAt: null },
    include: { provider: { include: { user: true } } },
    orderBy: { assignedAt: 'desc' },
    take: 1,
  },
  activities: { orderBy: { createdAt: 'asc' } },
  location: true,
  catalogRoot: true,
} satisfies Prisma.ServiceRequestInclude;

type RequestRow = Prisma.ServiceRequestGetPayload<{
  include: typeof requestInclude;
}>;
type V1ReadDb = Pick<Prisma.TransactionClient, 'user' | 'upload'>;

const fail = (
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): never => {
  throw new AppError(status, code as never, message, details);
};

const statusName = (
  status: RequestStatus,
): 'submitted' | 'approved' | 'denied' | 'cancelled' => {
  if (status === RequestStatus.approved) return 'approved';
  if (status === RequestStatus.rejected) return 'denied';
  if (status === RequestStatus.cancelled) return 'cancelled';
  return 'submitted';
};

const fullName = (user: {
  firstName: string | null;
  lastName: string | null;
  name: string | null;
  email: string;
}) =>
  [user.firstName, user.lastName].filter(Boolean).join(' ').trim() ||
  user.name ||
  user.email;

@Injectable()
export class V1Service {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
    private readonly uploads: UploadsService,
    private readonly settingsService: SettingsService,
    private readonly audit: AuditLogsService,
    private readonly idempotency: IdempotencyService,
  ) {}

  private async runIdempotent<T>(
    userId: string,
    key: string,
    request: Pick<Request, 'method' | 'originalUrl' | 'body'>,
    status: number,
    action: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<{ value: T; replayed: boolean }> {
    const hash = this.commandHash(request);
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${key}`}, 0))`,
        );
        const replay = await this.idempotency.lookup(userId, key, hash, tx);
        if (replay) return { value: replay.body as T, replayed: true };

        const value = await action(tx);
        await this.idempotency.store(userId, key, hash, status, value, tx);
        return { value, replayed: false };
      },
      { timeout: 15_000 },
    );
  }

  private commandHash(
    request: Pick<Request, 'method' | 'originalUrl' | 'body'>,
  ) {
    return this.idempotency.hashRequest(
      request.method,
      request.originalUrl,
      request.body,
    );
  }

  private async replayCommand<T>(
    userId: string,
    key: string,
    request: Pick<Request, 'method' | 'originalUrl' | 'body'>,
  ): Promise<T | null> {
    const replay = await this.idempotency.lookup(
      userId,
      key,
      this.commandHash(request),
    );
    return replay ? (replay.body as T) : null;
  }

  private async actor(userId: string): Promise<ActorContext> {
    return this.actors.resolve(userId);
  }

  private isAdmin(actor: ActorContext): boolean {
    return (
      actor.kind === 'staff' &&
      Boolean(actor.staff?.permissions.has('staff.manage'))
    );
  }

  private isXpro(actor: ActorContext): boolean {
    return actor.kind === 'staff' && actor.staff?.status === 'active';
  }

  private async findRequest(
    ref: string,
    actor: ActorContext,
  ): Promise<RequestRow> {
    const sequence = parseRequestId(ref);
    const row = await this.prisma.serviceRequest.findFirst({
      where: {
        workflowMode: RequestWorkflow.v1,
        ...(sequence === null ? { id: ref } : { number: sequence }),
        ...(this.isAdmin(actor)
          ? {}
          : actor.kind === 'staff'
            ? { staffOwnerId: actor.userId ?? undefined }
            : { ownerId: actor.userId ?? undefined }),
      },
      include: requestInclude,
    });
    if (!row)
      throw new AppError(404, 'NOT_FOUND', "We couldn't find that request.");
    return row;
  }

  private async projectRequest(
    row: RequestRow,
    actor: ActorContext,
    db: V1ReadDb = this.prisma,
  ) {
    const userIds = [
      row.ownerId,
      ...(row.staffOwnerId ? [row.staffOwnerId] : []),
    ];
    const users = await db.user.findMany({
      where: { id: { in: userIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        name: true,
        email: true,
        phoneE164: true,
      },
    });
    const owner = users.find((user) => user.id === row.ownerId);
    const assigneeUser = users.find((user) => user.id === row.staffOwnerId);
    const requestAttachments = await db.upload.findMany({
      where: { entityType: 'request', entityId: row.id, status: 'attached' },
      select: { id: true, fileName: true, size: true, contentType: true },
      orderBy: { createdAt: 'asc' },
    });
    const activeProvider = row.providerAssignments[0]?.provider;
    const isCustomer = actor.kind === 'customer';
    const assignedName =
      activeProvider?.businessName ||
      (activeProvider ? fullName(activeProvider.user) : undefined);

    return {
      id: formatRequestId(row.number),
      version: row.version,
      service: row.service,
      serviceId: row.serviceRootId ?? row.serviceId,
      title: row.title,
      description: row.description,
      location: row.location.name,
      locationId: row.locationId,
      address: row.address,
      phone: row.phone,
      contactMethod: row.contactMethod.toLowerCase(),
      budgetKobo: Number(row.budget),
      preferredDate: row.startDate ?? '',
      attachments: requestAttachments.map((file) => ({
        id: file.id,
        name: file.fileName,
        size: file.size,
        type: file.contentType,
      })),
      status: statusName(row.status),
      customer: {
        id: row.ownerId,
        name: owner ? fullName(owner) : row.customerName,
        email: owner?.email ?? '',
        phone: owner?.phoneE164 ?? row.phone,
      },
      assignee:
        !isCustomer && assigneeUser
          ? { id: assigneeUser.id, name: fullName(assigneeUser) }
          : null,
      createdAt: row.createdAt.toISOString(),
      decision: row.decision
        ? {
            status:
              row.decision.outcome === RequestDecisionOutcome.approved
                ? 'approved'
                : 'denied',
            ...(row.decision.reason ? { reason: row.decision.reason } : {}),
            by: isCustomer
              ? { id: 'xpro', name: 'Xpro' }
              : {
                  id: row.decision.decidedById,
                  name: row.decision.decidedByName,
                },
            at: row.decision.decidedAt.toISOString(),
            ...(activeProvider
              ? {
                  terms: {
                    providerId: activeProvider.id,
                    providerName:
                      activeProvider.businessName ||
                      fullName(activeProvider.user),
                    priceKobo: Number(row.providerAssignments[0].priceKobo),
                    date: row.providerAssignments[0].agreedDate,
                  },
                }
              : {}),
          }
        : { status: statusName(row.status) },
      provider: activeProvider
        ? {
            providerId: activeProvider.id,
            providerName: assignedName,
            assignedBy: isCustomer
              ? 'XPro Team'
              : row.providerAssignments[0].assignedByName,
            assignedAt: row.providerAssignments[0].assignedAt.toISOString(),
          }
        : null,
      ...(row.closedAt && row.status === RequestStatus.cancelled
        ? {
            cancelledAt: row.closedAt.toISOString(),
            cancelledBy: {
              id: row.closedBy,
              name: owner ? fullName(owner) : row.customerName,
            },
          }
        : {}),
      activity: isCustomer
        ? []
        : row.activities.map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            text: entry.text,
            by: entry.actorName,
            at: entry.createdAt.toISOString(),
            ...(entry.note ? { note: entry.note } : {}),
          })),
    };
  }

  async requestOptions(userId: string) {
    await this.actor(userId);
    const [services, locations] = await Promise.all([
      this.prisma.catalogService.findMany({
        where: { active: true, parentId: null },
        select: { id: true, name: true },
        orderBy: { sortOrder: 'asc' },
      }),
      this.prisma.location.findMany({
        where: {
          active: true,
          serviceable: true,
          kind: { in: ['lga', 'area'] },
        },
        select: { id: true, name: true, ancestorIds: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return {
      services,
      locations: locations.map(({ id, name }) => ({ id, name })),
    };
  }

  async requestSummary(userId: string) {
    const actor = await this.actor(userId);
    if (actor.kind === 'provider')
      fail(403, 'FORBIDDEN', 'Providers open their jobs from My jobs.');
    const where: Prisma.ServiceRequestWhereInput = {
      workflowMode: RequestWorkflow.v1,
      ...(this.isAdmin(actor)
        ? {}
        : actor.kind === 'staff'
          ? { staffOwnerId: userId }
          : { ownerId: userId }),
    };
    const [submitted, approved, denied, cancelled, unassigned, assigned] =
      await Promise.all([
        this.prisma.serviceRequest.count({
          where: { ...where, status: RequestStatus.submitted },
        }),
        this.prisma.serviceRequest.count({
          where: { ...where, status: RequestStatus.approved },
        }),
        this.prisma.serviceRequest.count({
          where: { ...where, status: RequestStatus.rejected },
        }),
        this.prisma.serviceRequest.count({
          where: { ...where, status: RequestStatus.cancelled },
        }),
        this.prisma.serviceRequest.count({
          where: {
            ...where,
            status: RequestStatus.submitted,
            staffOwnerId: null,
          },
        }),
        this.prisma.serviceRequest.count({
          where: {
            ...where,
            status: RequestStatus.submitted,
            staffOwnerId: { not: null },
          },
        }),
      ]);
    return {
      submitted,
      approved,
      denied,
      cancelled,
      ...(this.isAdmin(actor) ? { unassigned, assigned } : {}),
    };
  }

  async listRequests(userId: string, query: V1ListRequestsQueryDto) {
    const actor = await this.actor(userId);
    if (actor.kind === 'provider')
      fail(403, 'FORBIDDEN', 'Providers open their jobs from My jobs.');
    const status =
      query.status === 'approved'
        ? RequestStatus.approved
        : query.status === 'denied'
          ? RequestStatus.rejected
          : query.status === 'cancelled'
            ? RequestStatus.cancelled
            : query.status === 'submitted'
              ? RequestStatus.submitted
              : undefined;
    const where: Prisma.ServiceRequestWhereInput = {
      workflowMode: RequestWorkflow.v1,
      ...(status ? { status } : {}),
      ...(this.isAdmin(actor)
        ? query.assignee === 'unassigned'
          ? { staffOwnerId: null }
          : query.assignee && query.assignee !== 'assigned'
            ? { staffOwnerId: query.assignee }
            : query.assignee === 'assigned'
              ? { staffOwnerId: { not: null } }
              : {}
        : actor.kind === 'staff'
          ? { staffOwnerId: userId }
          : { ownerId: userId }),
      ...(query.service
        ? { service: { contains: query.service, mode: 'insensitive' } }
        : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' } },
              { service: { contains: query.q, mode: 'insensitive' } },
              ...(parseRequestId(query.q) !== null
                ? [{ number: parseRequestId(query.q)! }]
                : []),
            ],
          }
        : {}),
    };
    const page = query.page ?? 1;
    const itemsPerPage = query.itemsPerPage ?? 10;
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.serviceRequest.findMany({
        where,
        include: requestInclude,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * itemsPerPage,
        take: itemsPerPage,
      }),
      this.prisma.serviceRequest.count({ where }),
    ]);
    return {
      items: await Promise.all(
        rows.map((row) => this.projectRequest(row, actor)),
      ),
      total,
      page,
      itemsPerPage,
    };
  }

  async getRequest(userId: string, ref: string) {
    const actor = await this.actor(userId);
    return this.projectRequest(await this.findRequest(ref, actor), actor);
  }

  async createRequest(
    userId: string,
    dto: V1CreateRequestDto,
    key: string,
    request: Request,
  ) {
    const actor = await this.actor(userId);
    if (actor.kind !== 'customer' || !actor.platformRoles.includes('customer'))
      fail(403, 'FORBIDDEN', 'Only customers can submit requests.');
    const replay = await this.replayCommand<
      Awaited<ReturnType<typeof this.projectRequest>>
    >(userId, key, request);
    if (replay) return replay;
    const [user, service, location] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { firstName: true, lastName: true, name: true, email: true },
      }),
      this.prisma.catalogService.findFirst({
        where: { id: dto.service, parentId: null, active: true },
      }),
      this.prisma.location.findFirst({
        where: { id: dto.location, active: true, serviceable: true },
      }),
    ]);
    if (!user)
      throw new AppError(404, 'NOT_FOUND', 'Customer account not found.');
    if (!service)
      throw new AppError(422, 'VALIDATION_ERROR', 'Choose an active service.');
    if (!location)
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'Choose a location Xpro serves.',
      );
    const phone = normalizeNigerianPhone(dto.phone);
    if (!phone)
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'Enter a valid Nigerian phone number.',
      );
    const execution = await this.runIdempotent(
      userId,
      key,
      request,
      201,
      async (tx) => {
        await tx.$executeRaw(
          Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${'v1-open-request-limit:' + userId}, 0))`,
        );
        const [ownerLimit, open, settingsRows] = await Promise.all([
          tx.user.findUnique({
            where: { id: userId },
            select: { openRequestLimit: true },
          }),
          tx.serviceRequest.count({
            where: {
              workflowMode: RequestWorkflow.v1,
              ownerId: userId,
              status: RequestStatus.submitted,
            },
          }),
          this.settingsService.snapshot(),
        ]);
        const settings = Object.fromEntries(
          settingsRows.map(({ key: settingKey, value }) => [settingKey, value]),
        );
        const limit =
          ownerLimit?.openRequestLimit ?? platformOpenRequestLimit(settings);
        const allowance = evaluateOpenRequestLimit({
          open,
          limit,
          requested: 1,
        });
        if ('code' in allowance)
          fail(422, allowance.code, allowance.message, allowance.details);
        const row = await tx.serviceRequest.create({
          data: {
            ownerId: userId,
            customerName: fullName({ ...user, email: user.email }),
            title: dto.title.trim(),
            service: service.name,
            serviceId: service.id,
            serviceRootId: service.id,
            locationId: location.id,
            address: dto.address.trim(),
            phone,
            contactMethod: dto.contactMethod,
            description: dto.description.trim(),
            budget: BigInt(dto.budgetKobo),
            startDate: dto.preferredDate || null,
            status: RequestStatus.submitted,
            version: 1,
            workflowMode: RequestWorkflow.v1,
            dispatchMode: 'manual',
            intakeState: 'pending',
            answers: [],
            details: {},
            unclaimedSince: null,
            contactInBrief: false,
          },
        });
        const uploads = await this.uploads.attach(
          tx,
          dto.attachments.map((file) => file.id),
          userId,
          UploadPurpose.request_attachment,
          'request',
          row.id,
        );
        if (uploads.length)
          await tx.requestAttachment.createMany({
            data: uploads.map((upload) => ({
              requestId: row.id,
              uploadId: upload.id,
            })),
          });
        await tx.requestActivity.create({
          data: {
            requestId: row.id,
            kind: RequestActivityKind.submitted,
            actorId: userId,
            actorName: actor.displayName,
            text: `${actor.displayName} submitted the request`,
          },
        });
        const created = await tx.serviceRequest.findFirstOrThrow({
          where: { id: row.id },
          include: requestInclude,
        });
        return this.projectRequest(created, actor, tx);
      },
    );
    if (!execution.replayed)
      this.audit.record({
        actorType: 'customer',
        actorId: userId,
        entityType: 'service_request',
        entityId: execution.value.id,
        action: 'v1.request.created',
      });
    return execution.value;
  }

  async assignStaff(
    userId: string,
    ref: string,
    dto: V1AssignStaffDto,
    version: number,
    key: string,
    request: Request,
  ) {
    const actor = await this.actor(userId);
    if (!this.isAdmin(actor))
      fail(403, 'FORBIDDEN', 'Only an admin can assign staff.');
    const replay = await this.replayCommand<
      Awaited<ReturnType<typeof this.projectRequest>>
    >(userId, key, request);
    if (replay) return replay;
    const current = await this.findRequest(ref, actor);
    this.assertVersion(current, version);
    if ((dto.expectedOwnerId ?? null) !== current.staffOwnerId)
      fail(
        409,
        'OWNER_CHANGED',
        'Someone else changed the assignee. Refresh and try again.',
      );
    const member = await this.prisma.staffMember.findFirst({
      where: {
        userId: dto.staffId,
        status: 'active',
        canOwnRequests: true,
        user: { status: 'active' },
      },
      include: {
        user: {
          select: { firstName: true, lastName: true, name: true, email: true },
        },
      },
    });
    if (!member)
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'Choose an active staff member.',
      );
    const execution = await this.runIdempotent(
      userId,
      key,
      request,
      200,
      async (tx) => {
        await this.bumpVersion(tx, current.id, version, {
          staffOwnerId: member.userId,
          claimedAt: new Date(),
          unclaimedSince: null,
          ownershipVersion: { increment: 1 },
        });
        await tx.requestActivity.create({
          data: {
            requestId: current.id,
            kind: current.staffOwnerId
              ? RequestActivityKind.reassigned
              : RequestActivityKind.assigned,
            actorId: userId,
            actorName: actor.displayName,
            text: `${actor.displayName} ${current.staffOwnerId ? 'reassigned the request to' : 'assigned'} ${fullName({ ...member.user, email: member.user.email })}`,
            ...(dto.note ? { note: dto.note.trim() } : {}),
          },
        });
        const updated = await tx.serviceRequest.findFirstOrThrow({
          where: { id: current.id },
          include: requestInclude,
        });
        return this.projectRequest(updated, actor, tx);
      },
    );
    if (!execution.replayed)
      this.audit.record({
        actorType: 'staff',
        actorId: userId,
        entityType: 'service_request',
        entityId: current.id,
        action: current.staffOwnerId
          ? 'v1.request.staff_reassigned'
          : 'v1.request.staff_assigned',
        metadata: { staffId: member.userId },
      });
    return execution.value;
  }

  async approve(
    userId: string,
    ref: string,
    dto: V1ApproveDto,
    version: number,
    key: string,
    request: Request,
  ) {
    const actor = await this.actor(userId);
    if (!this.isXpro(actor))
      fail(403, 'FORBIDDEN', 'Only Xpro staff can approve a request.');
    const replay = await this.replayCommand<
      Awaited<ReturnType<typeof this.projectRequest>>
    >(userId, key, request);
    if (replay) return replay;
    const current = await this.findRequest(ref, actor);
    if (!this.isAdmin(actor) && current.staffOwnerId !== userId)
      fail(
        403,
        'FORBIDDEN',
        'Only the assigned staff member can approve this request.',
      );
    this.assertVersion(current, version);
    this.assertSubmitted(current);
    if (!current.staffOwnerId)
      fail(422, 'ASSIGNEE_REQUIRED', 'Assign a staff member before approving.');
    const decisionAt = new Date();
    const execution = await this.runIdempotent(
      userId,
      key,
      request,
      200,
      async (tx) => {
        await this.bumpVersion(tx, current.id, version, {
          status: RequestStatus.approved,
          intakeApprovedBy: userId,
          intakeApprovedAt: decisionAt,
        });
        await tx.requestDecision.create({
          data: {
            requestId: current.id,
            outcome: RequestDecisionOutcome.approved,
            decidedById: userId,
            decidedByName: actor.displayName,
            decidedAt: decisionAt,
          },
        });
        await tx.requestActivity.create({
          data: {
            requestId: current.id,
            kind: RequestActivityKind.approved,
            actorId: userId,
            actorName: actor.displayName,
            text: `${actor.displayName} approved the request`,
          },
        });
        const updated = await tx.serviceRequest.findFirstOrThrow({
          where: { id: current.id },
          include: requestInclude,
        });
        return this.projectRequest(updated, actor, tx);
      },
    );
    if (!execution.replayed)
      this.audit.record({
        actorType: 'staff',
        actorId: userId,
        entityType: 'service_request',
        entityId: current.id,
        action: 'v1.request.approved',
      });
    return execution.value;
  }

  async deny(
    userId: string,
    ref: string,
    dto: V1DenyDto,
    version: number,
    key: string,
    request: Request,
  ) {
    const actor = await this.actor(userId);
    if (!this.isAdmin(actor))
      fail(403, 'FORBIDDEN', 'Only an admin can deny a request.');
    const replay = await this.replayCommand<
      Awaited<ReturnType<typeof this.projectRequest>>
    >(userId, key, request);
    if (replay) return replay;
    const current = await this.findRequest(ref, actor);
    this.assertVersion(current, version);
    this.assertSubmitted(current);
    const reason = dto.reason.trim();
    const now = new Date();
    const execution = await this.runIdempotent(
      userId,
      key,
      request,
      200,
      async (tx) => {
        await this.bumpVersion(tx, current.id, version, {
          status: RequestStatus.rejected,
        });
        await tx.requestDecision.create({
          data: {
            requestId: current.id,
            outcome: RequestDecisionOutcome.denied,
            reason,
            decidedById: userId,
            decidedByName: actor.displayName,
            decidedAt: now,
          },
        });
        await tx.requestActivity.create({
          data: {
            requestId: current.id,
            kind: RequestActivityKind.denied,
            actorId: userId,
            actorName: actor.displayName,
            text: `${actor.displayName} denied the request`,
            note: reason,
          },
        });
        const updated = await tx.serviceRequest.findFirstOrThrow({
          where: { id: current.id },
          include: requestInclude,
        });
        return this.projectRequest(updated, actor, tx);
      },
    );
    if (!execution.replayed)
      this.audit.record({
        actorType: 'staff',
        actorId: userId,
        entityType: 'service_request',
        entityId: current.id,
        action: 'v1.request.denied',
      });
    return execution.value;
  }

  async cancel(
    userId: string,
    ref: string,
    version: number,
    key: string,
    request: Request,
  ) {
    const actor = await this.actor(userId);
    if (actor.kind !== 'customer' || !actor.platformRoles.includes('customer'))
      fail(403, 'FORBIDDEN', 'Only a customer can cancel a request.');
    const replay = await this.replayCommand<
      Awaited<ReturnType<typeof this.projectRequest>>
    >(userId, key, request);
    if (replay) return replay;
    const current = await this.findRequest(ref, actor);
    this.assertVersion(current, version);
    this.assertSubmitted(current);
    const now = new Date();
    const execution = await this.runIdempotent(
      userId,
      key,
      request,
      200,
      async (tx) => {
        await this.bumpVersion(tx, current.id, version, {
          status: RequestStatus.cancelled,
          closedAt: now,
          closedBy: userId,
        });
        await tx.requestActivity.create({
          data: {
            requestId: current.id,
            kind: RequestActivityKind.cancelled,
            actorId: userId,
            actorName: actor.displayName,
            text: `${actor.displayName} cancelled the request`,
          },
        });
        const updated = await tx.serviceRequest.findFirstOrThrow({
          where: { id: current.id },
          include: requestInclude,
        });
        return this.projectRequest(updated, actor, tx);
      },
    );
    if (!execution.replayed)
      this.audit.record({
        actorType: 'customer',
        actorId: userId,
        entityType: 'service_request',
        entityId: current.id,
        action: 'v1.request.cancelled',
      });
    return execution.value;
  }

  private assertVersion(row: RequestRow, version: number) {
    if (row.version !== version)
      fail(
        409,
        'VERSION_CONFLICT',
        'This request changed since you opened it.',
        { current: { version: row.version } },
      );
  }

  private async bumpVersion(
    tx: Prisma.TransactionClient,
    requestId: string,
    version: number,
    data: Prisma.ServiceRequestUpdateManyMutationInput = {},
  ) {
    const updated = await tx.serviceRequest.updateMany({
      where: { id: requestId, workflowMode: RequestWorkflow.v1, version },
      data: { ...data, version: { increment: 1 } },
    });
    if (updated.count !== 1)
      throw new AppError(
        409,
        'VERSION_CONFLICT',
        'This request changed since you opened it.',
      );
  }

  private assertSubmitted(row: RequestRow) {
    if (row.status !== RequestStatus.submitted)
      fail(409, 'ALREADY_DECIDED', 'This request has already been decided.', {
        current: { status: statusName(row.status), version: row.version },
      });
  }

  private async eligibleProvider(request: RequestRow, providerId: string) {
    const profile = await this.prisma.providerProfile.findFirst({
      where: {
        id: providerId,
        verification: ProviderVerificationStatus.approved,
        available: true,
        reliabilityStatus: { not: 'restricted' },
        user: { status: 'active' },
      },
      include: { user: { select: { id: true } } },
    });
    if (!profile) return null;
    const services = Array.isArray(profile.services) ? profile.services : [];
    const serviceIds = Array.isArray(profile.serviceIds)
      ? profile.serviceIds
      : [];
    const serviceValues = [...services, ...serviceIds].filter(
      (item): item is string => typeof item === 'string',
    );
    if (
      !serviceValues.includes(request.service) &&
      !serviceValues.includes(request.serviceId ?? '')
    )
      return null;
    return { ...profile, userId: profile.userId };
  }

  async providerCandidates(userId: string, ref: string) {
    const actor = await this.actor(userId);
    if (!this.isXpro(actor))
      fail(403, 'FORBIDDEN', 'Only Xpro staff can view provider candidates.');
    const request = await this.findRequest(ref, actor);
    const profiles = await this.prisma.providerProfile.findMany({
      where: {
        verification: ProviderVerificationStatus.approved,
        available: true,
        reliabilityStatus: { not: 'restricted' },
        user: { status: 'active' },
      },
      include: {
        user: {
          select: { firstName: true, lastName: true, name: true, email: true },
        },
      },
    });
    return profiles
      .flatMap((profile) => {
        const values = [
          ...(Array.isArray(profile.services) ? profile.services : []),
          ...(Array.isArray(profile.serviceIds) ? profile.serviceIds : []),
        ].filter((item): item is string => typeof item === 'string');
        if (
          !values.includes(request.service) &&
          !values.includes(request.serviceId ?? '')
        )
          return [];
        const name = profile.businessName || fullName(profile.user);
        const servesLocation = [
          request.locationId,
          ...request.location.ancestorIds,
        ].some((id) => profile.serviceAreaIds.includes(id));
        return [
          {
            id: profile.id,
            name,
            trade: profile.trade,
            services: values,
            areas: profile.serviceAreaIds,
            verified: true,
            available: true,
            score: servesLocation ? 15 : 10,
            reasons: [
              `Offers ${request.service}`,
              ...(servesLocation ? [`Serves ${request.location.name}`] : []),
            ],
          },
        ];
      })
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }

  async replaceProvider(
    userId: string,
    ref: string,
    dto: V1ReplaceProviderDto,
    version: number,
    key: string,
    request: Request,
  ) {
    const actor = await this.actor(userId);
    if (!this.isXpro(actor))
      fail(403, 'FORBIDDEN', 'Only Xpro staff can replace a provider.');
    const replay = await this.replayCommand<
      Awaited<ReturnType<typeof this.projectRequest>>
    >(userId, key, request);
    if (replay) return replay;
    const current = await this.findRequest(ref, actor);
    if (!this.isAdmin(actor) && current.staffOwnerId !== userId)
      fail(
        403,
        'FORBIDDEN',
        'Only the assigned staff member can manage this provider assignment.',
      );
    this.assertVersion(current, version);
    if (current.status !== RequestStatus.approved)
      fail(
        409,
        'NOT_APPROVED',
        'A provider can only be assigned after approval.',
      );
    const provider = await this.eligibleProvider(current, dto.providerId);
    if (!provider)
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'Choose a verified, available provider that offers this service.',
      );
    const existing = current.providerAssignments[0];
    if (existing?.providerProfileId === provider.id)
      fail(422, 'VALIDATION_ERROR', 'Choose a different provider.');
    const reason = dto.reason?.trim() ?? '';
    if (existing && reason.length < 10)
      fail(422, 'VALIDATION_ERROR', 'Give a reason of at least 10 characters.');
    const priceKobo =
      dto.priceKobo ??
      (existing?.priceKobo ? Number(existing.priceKobo) : undefined);
    const agreedDate = dto.date ?? existing?.agreedDate ?? undefined;
    if (!priceKobo || priceKobo < 1 || !agreedDate)
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'Enter the agreed price and date.',
      );
    if (
      Number.isNaN(new Date(`${agreedDate}T00:00:00.000Z`).getTime()) ||
      agreedDate < new Date().toISOString().slice(0, 10)
    )
      throw new AppError(
        422,
        'VALIDATION_ERROR',
        'Choose today or a later date.',
      );
    const execution = await this.runIdempotent(
      userId,
      key,
      request,
      200,
      async (tx) => {
        const assignmentId = randomUUID();
        await this.bumpVersion(tx, current.id, version);
        if (existing)
          await tx.requestProviderAssignment.update({
            where: { id: existing.id },
            data: {
              endedAt: new Date(),
              endedById: userId,
              endReason: reason,
              replacedById: assignmentId,
            },
          });
        await tx.requestProviderAssignment.create({
          data: {
            id: assignmentId,
            requestId: current.id,
            providerProfileId: provider.id,
            providerUserId: provider.userId,
            assignedById: userId,
            assignedByName: actor.displayName,
            assignedAt: new Date(),
            priceKobo: BigInt(priceKobo),
            agreedDate,
          },
        });
        await tx.requestActivity.create({
          data: {
            requestId: current.id,
            kind: existing
              ? RequestActivityKind.provider_replaced
              : RequestActivityKind.provider_assigned,
            actorId: userId,
            actorName: actor.displayName,
            text: existing
              ? `${actor.displayName} replaced the assigned provider`
              : `${actor.displayName} assigned a provider`,
            ...(reason ? { note: reason } : {}),
          },
        });
        const updated = await tx.serviceRequest.findFirstOrThrow({
          where: { id: current.id },
          include: requestInclude,
        });
        return this.projectRequest(updated, actor, tx);
      },
    );
    if (!execution.replayed)
      this.audit.record({
        actorType: 'staff',
        actorId: userId,
        entityType: 'service_request',
        entityId: current.id,
        action: existing
          ? 'v1.request.provider_replaced'
          : 'v1.request.provider_assigned',
        metadata: { providerId: provider.id },
      });
    return execution.value;
  }

  async messages(userId: string, ref: string, channel?: string) {
    if (channel && channel !== 'customer')
      fail(
        403,
        'FORBIDDEN',
        'Choose a conversation available to your account.',
      );
    const actor = await this.actor(userId);
    const request = await this.findRequest(ref, actor);
    const rows = await this.prisma.requestMessage.findMany({
      where: { requestId: request.id, channel: 'customer' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const staffAuthorIds = [
      ...new Set(
        rows.flatMap((message) =>
          message.authorRole === 'customer' || !message.authorId
            ? []
            : [message.authorId],
        ),
      ),
    ];
    const staffAuthors = await this.prisma.user.findMany({
      where: { id: { in: staffAuthorIds } },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        name: true,
        email: true,
      },
    });
    const authorNames = new Map(
      staffAuthors.map((user) => [user.id, fullName(user)]),
    );
    return Promise.all(
      rows.map(async (message) => {
        const files = await this.prisma.upload.findMany({
          where: {
            entityType: 'message',
            entityId: message.id,
            status: 'attached',
          },
          select: { id: true, fileName: true, size: true, contentType: true },
          orderBy: { createdAt: 'asc' },
        });
        const counter = await this.prisma.requestCounterOffer.findUnique({
          where: { messageId: message.id },
        });
        return {
          id: message.id,
          requestId: formatRequestId(request.number),
          kind: message.kind,
          authorId: message.authorId ?? '',
          authorRole: message.authorRole,
          authorLabel:
            message.authorRole === 'customer'
              ? request.customerName
              : actor.kind === 'customer'
                ? 'XPro Team'
                : (authorNames.get(message.authorId ?? '') ??
                  message.authorRole),
          text: message.text,
          attachments: files.map((file) => ({
            id: file.id,
            name: file.fileName,
            size: file.size,
            type: file.contentType,
          })),
          createdAt: message.createdAt.toISOString(),
          ...(counter
            ? {
                counter: {
                  id: counter.id,
                  amountKobo: Number(counter.amountKobo),
                  date: counter.proposedDate,
                  note: counter.note,
                  supersededBy: counter.supersededById,
                },
              }
            : {}),
        };
      }),
    );
  }

  async sendMessage(
    userId: string,
    ref: string,
    dto: V1SendMessageDto,
    key: string,
    requestDetails: Request,
  ) {
    const actor = await this.actor(userId);
    const request = await this.findRequest(ref, actor);
    const isCustomer =
      actor.kind === 'customer' && actor.platformRoles.includes('customer');
    const isAssignedStaff =
      actor.kind === 'staff' && request.staffOwnerId === userId;
    if (!isCustomer && !this.isAdmin(actor) && !isAssignedStaff)
      fail(403, 'FORBIDDEN', 'You cannot send messages for this request.');
    const replay = await this.replayCommand<string>(
      userId,
      key,
      requestDetails,
    );
    if (replay)
      return (await this.messages(userId, ref)).find(
        (item) => item.id === replay,
      );
    if (dto.channel !== 'customer')
      fail(
        403,
        'FORBIDDEN',
        'Choose a conversation available to your account.',
      );
    const text = dto.text.trim();
    if (dto.kind === 'text' && !text && !dto.attachments.length)
      fail(422, 'VALIDATION_ERROR', 'Write a message or attach a file.');
    if (dto.kind === 'counter' && !dto.counter)
      fail(422, 'VALIDATION_ERROR', 'Enter the offer.');
    const execution = await this.runIdempotent(
      userId,
      key,
      requestDetails,
      201,
      async (tx) => {
        await tx.$executeRaw`SELECT id FROM "service_requests" WHERE id = ${request.id} FOR UPDATE`;
        const current = await tx.serviceRequest.findFirst({
          where: { id: request.id, workflowMode: RequestWorkflow.v1 },
          select: { status: true },
        });
        if (!current)
          throw new AppError(
            404,
            'NOT_FOUND',
            "We couldn't find that request.",
          );
        if (
          dto.kind === 'counter' &&
          current.status !== RequestStatus.submitted
        )
          fail(
            409,
            'COUNTER_CLOSED',
            'Offers are closed once a request is decided.',
          );
        const created = await tx.requestMessage.create({
          data: {
            requestId: request.id,
            channel: 'customer',
            authorId: userId,
            authorRole: isCustomer
              ? 'customer'
              : this.isAdmin(actor)
                ? 'admin'
                : 'staff',
            text: dto.kind === 'counter' ? '' : text,
            kind:
              dto.kind === 'counter' ? MessageKind.counter : MessageKind.text,
          },
        });
        if (dto.kind === 'counter' && dto.counter) {
          const latest = await tx.requestCounterOffer.findFirst({
            where: { requestId: request.id, supersededById: null },
            orderBy: { createdAt: 'desc' },
          });
          if (isCustomer && (!latest || latest.authorRole === 'customer'))
            fail(
              409,
              'NO_OFFER_TO_COUNTER',
              'There is no offer from Xpro to counter.',
            );
          if (!isCustomer && latest && latest.authorRole !== 'customer')
            fail(
              409,
              'NO_OFFER_TO_COUNTER',
              'Wait for the customer to respond before sending another offer.',
            );
          const counterId = randomUUID();
          if (latest)
            await tx.requestCounterOffer.update({
              where: { id: latest.id },
              data: { supersededById: counterId, supersededAt: new Date() },
            });
          await tx.requestCounterOffer.create({
            data: {
              id: counterId,
              requestId: request.id,
              messageId: created.id,
              authorRole: isCustomer ? 'customer' : created.authorRole,
              amountKobo: BigInt(dto.counter.amountKobo),
              proposedDate: dto.counter.date || null,
              note: (dto.counter.note ?? '').trim(),
            },
          });
        }
        const uploadIds = dto.attachments.map((file) => file.id);
        await this.uploads.attach(
          tx,
          uploadIds,
          userId,
          UploadPurpose.message_attachment,
          'message',
          created.id,
        );
        return created.id;
      },
    );
    if (!execution.replayed)
      this.audit.record({
        actorType: isCustomer ? 'customer' : 'staff',
        actorId: userId,
        entityType: 'request_message',
        entityId: execution.value,
        action: 'v1.message.sent',
        metadata: {
          requestId: request.id,
          kind: dto.kind,
          attachmentCount: dto.attachments.length,
        },
      });
    return (await this.messages(userId, ref)).find(
      (item) => item.id === execution.value,
    );
  }

  async adminConversations(userId: string, query?: string, channel?: string) {
    const actor = await this.actor(userId);
    if (!this.isAdmin(actor))
      fail(
        403,
        'FORBIDDEN',
        'Only admins can open the customer conversation inbox.',
      );
    if (channel && channel !== 'customer')
      fail(
        403,
        'FORBIDDEN',
        'Choose a conversation available to your account.',
      );
    const q = query?.trim().toLowerCase();
    const requests = await this.prisma.serviceRequest.findMany({
      where: { workflowMode: RequestWorkflow.v1 },
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        ownerId: true,
        staffOwnerId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const rows = await this.conversationRows(requests, actor);
    return q
      ? rows.filter((row) =>
          `${row.requestId} ${row.title} ${row.customer.name}`
            .toLowerCase()
            .includes(q),
        )
      : rows;
  }

  async customerConversations(userId: string) {
    const actor = await this.actor(userId);
    if (actor.kind !== 'customer' || !actor.platformRoles.includes('customer'))
      fail(403, 'FORBIDDEN', 'Only customers can open their conversations.');
    const requests = await this.prisma.serviceRequest.findMany({
      where: { workflowMode: RequestWorkflow.v1, ownerId: userId },
      select: {
        id: true,
        number: true,
        title: true,
        status: true,
        ownerId: true,
        staffOwnerId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    return this.conversationRows(requests, actor);
  }

  private async conversationRows(
    requests: Array<{
      id: string;
      number: number;
      title: string;
      status: RequestStatus;
      ownerId: string;
      staffOwnerId: string | null;
      createdAt: Date;
    }>,
    actor: ActorContext,
  ) {
    const rows = [];
    for (const request of requests) {
      const messages = await this.prisma.requestMessage.findMany({
        where: { requestId: request.id, channel: 'customer' },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      if (!messages.length) continue;
      const lastMessage = messages[0];
      const latestXpro = await this.prisma.requestMessage.findFirst({
        where: {
          requestId: request.id,
          channel: 'customer',
          authorRole: { in: ['admin', 'staff'] },
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const waitingForXpro = await this.prisma.requestMessage.count({
        where: {
          requestId: request.id,
          channel: 'customer',
          authorRole: 'customer',
          ...(latestXpro ? { createdAt: { gt: latestXpro.createdAt } } : {}),
        },
      });
      const owner = await this.prisma.user.findUnique({
        where: { id: request.ownerId },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          name: true,
          email: true,
        },
      });
      rows.push({
        requestId: formatRequestId(request.number),
        title: request.title,
        status: statusName(request.status),
        customer: {
          id: request.ownerId,
          name: owner ? fullName(owner) : 'Customer',
        },
        assignee:
          actor.kind === 'customer'
            ? null
            : await this.staffPerson(request.staffOwnerId),
        lastMessage: {
          kind: lastMessage.kind,
          authorRole: lastMessage.authorRole,
          authorLabel:
            lastMessage.authorRole === 'customer'
              ? owner
                ? fullName(owner)
                : 'Customer'
              : 'XPro Team',
          text: lastMessage.text,
          at: lastMessage.createdAt.toISOString(),
        },
        waitingForXpro,
      });
    }
    return rows.sort((a, b) =>
      b.lastMessage.at.localeCompare(a.lastMessage.at),
    );
  }

  private async staffPerson(id: string | null) {
    if (!id) return null;
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        name: true,
        email: true,
      },
    });
    return user ? { id, name: fullName(user) } : null;
  }

  async providerJobs(userId: string) {
    const actor = await this.actor(userId);
    if (actor.kind !== 'provider' || !actor.platformRoles.includes('provider'))
      fail(403, 'FORBIDDEN', 'Provider access is required.');
    const rows = await this.prisma.requestProviderAssignment.findMany({
      where: {
        providerUserId: userId,
        endedAt: null,
        request: {
          workflowMode: RequestWorkflow.v1,
          status: RequestStatus.approved,
        },
      },
      include: { request: { include: { location: true, attachments: true } } },
      orderBy: { assignedAt: 'desc' },
    });
    return Promise.all(rows.map((item) => this.jobProjection(item, userId)));
  }

  async providerJob(userId: string, ref: string) {
    const actor = await this.actor(userId);
    if (actor.kind !== 'provider' || !actor.platformRoles.includes('provider'))
      fail(403, 'FORBIDDEN', 'Provider access is required.');
    const sequence = parseRequestId(ref);
    const row = await this.prisma.requestProviderAssignment.findFirst({
      where: {
        providerUserId: userId,
        endedAt: null,
        request: {
          workflowMode: RequestWorkflow.v1,
          status: RequestStatus.approved,
          ...(sequence === null ? { id: ref } : { number: sequence }),
        },
      },
      include: { request: { include: { location: true, attachments: true } } },
    });
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Job not found.');
    return this.jobProjection(row, userId);
  }

  private async jobProjection(
    item: {
      request:
        | RequestRow
        | Prisma.ServiceRequestGetPayload<{
            include: { location: true; attachments: true };
          }>;
      assignedAt: Date;
      agreedDate: string;
    },
    _userId: string,
  ) {
    const request = item.request;
    const owner = await this.prisma.user.findUnique({
      where: { id: request.ownerId },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        name: true,
        email: true,
        phoneE164: true,
      },
    });
    const uploads = await this.prisma.upload.findMany({
      where: {
        entityType: 'request',
        entityId: request.id,
        status: 'attached',
      },
      select: { id: true, fileName: true, size: true, contentType: true },
    });
    return {
      id: formatRequestId(request.number),
      title: request.title,
      service: request.service,
      description: request.description,
      location: request.location.name,
      address: request.address,
      date: item.agreedDate,
      assignedAt: item.assignedAt.toISOString(),
      customer: {
        name: owner ? fullName(owner) : request.customerName,
        phone: owner?.phoneE164 ?? request.phone,
        contactMethod: request.contactMethod.toLowerCase(),
      },
      attachments: uploads.map((file) => ({
        id: file.id,
        name: file.fileName,
        size: file.size,
        type: file.contentType,
      })),
    };
  }
}
