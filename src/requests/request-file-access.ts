import { Injectable, OnModuleInit } from '@nestjs/common';
import { ActorService } from '../platform/actor/actor.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  ISSUE_ENTITY,
  MESSAGE_ENTITY,
  NOSHOW_ENTITY,
  PROGRESS_UPDATE_ENTITY,
  REQUEST_ENTITY,
} from '../uploads/entity-types';
import { FileAccessService } from '../uploads/file-access.service';
import type { RequestUser } from '../common/types/request-user';

const ACCESSIBLE_ASSIGNMENTS = [
  'offered',
  'pending_approval',
  'accepted',
  'completed',
] as const;

@Injectable()
export class RequestFileAccess implements OnModuleInit {
  constructor(
    private readonly access: FileAccessService,
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
  ) {}

  onModuleInit(): void {
    this.access.register(REQUEST_ENTITY, async (user: RequestUser, upload) => {
      if (!upload.entityId) return false;
      const actor = await this.actors.resolve(user.id);
      const request = await this.prisma.serviceRequest.findUnique({
        where: { id: upload.entityId },
        select: {
          ownerId: true,
          workflowMode: true,
          staffOwnerId: true,
          providerAssignments: {
            where: { endedAt: null },
            select: { providerUserId: true },
            take: 1,
          },
          assignments: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { id: true, providerUserId: true, status: true },
          },
          attachments: {
            where: { uploadId: upload.id },
            select: { sharedWithProvider: true },
          },
          schedules: {
            where: { status: 'confirmed' },
            select: { assignmentId: true },
          },
        },
      });
      if (!request) return false;
      if (request.ownerId === user.id) return true;
      if (request.workflowMode === 'v1') {
        if (actor.staff?.status === 'active')
          return (
            actor.staff.permissions.has('staff.manage') ||
            request.staffOwnerId === user.id
          );
        return (
          actor.kind === 'provider' &&
          request.providerAssignments[0]?.providerUserId === user.id
        );
      }
      if (actor.kind === 'staff' && actor.staff?.status === 'active')
        return true;
      const currentAssignment = request.assignments[0];
      if (
        !actor.platformRoles.includes('provider') ||
        currentAssignment?.providerUserId !== user.id ||
        !new Set<string>(ACCESSIBLE_ASSIGNMENTS).has(currentAssignment.status)
      )
        return false;
      const scheduleLocked = request.schedules.some(
        (schedule) => schedule.assignmentId === currentAssignment.id,
      );
      return (
        scheduleLocked ||
        request.attachments.some((attachment) => attachment.sharedWithProvider)
      );
    });

    this.access.register(MESSAGE_ENTITY, async (user, upload) => {
      if (!upload.entityId) return false;
      const actor = await this.actors.resolve(user.id);
      const message = await this.prisma.requestMessage.findUnique({
        where: { id: upload.entityId },
        select: {
          requestId: true,
          channel: true,
          providerId: true,
          request: {
            select: {
              ownerId: true,
              workflowMode: true,
              staffOwnerId: true,
              assignments: {
                orderBy: { createdAt: 'desc' },
                select: {
                  providerId: true,
                  providerUserId: true,
                  status: true,
                },
              },
            },
          },
        },
      });
      if (!message) return false;
      if (message.channel === 'customer') {
        if (
          actor.platformRoles.includes('customer') &&
          message.request.ownerId === user.id
        )
          return true;
        if (message.request.workflowMode === 'v1')
          return Boolean(
            actor.staff?.status === 'active' &&
            (actor.staff.permissions.has('staff.manage') ||
              message.request.staffOwnerId === user.id),
          );
        if (actor.kind === 'staff')
          return (
            actor.staff?.status === 'active' &&
            actor.staff.permissions.has('message.customer')
          );
        return false;
      }
      if (message.channel === 'internal')
        return (
          actor.kind === 'staff' &&
          actor.staff?.status === 'active' &&
          actor.staff.permissions.has('message.internal')
        );
      if (actor.kind === 'staff')
        return (
          actor.staff?.status === 'active' &&
          actor.staff.permissions.has('message.provider')
        );
      if (!actor.platformRoles.includes('provider') || !message.providerId)
        return false;
      const current = message.request.assignments[0];
      return (
        current?.providerId === message.providerId &&
        current.providerUserId === user.id &&
        ACCESSIBLE_ASSIGNMENTS.includes(
          current.status as (typeof ACCESSIBLE_ASSIGNMENTS)[number],
        )
      );
    });

    this.access.register(PROGRESS_UPDATE_ENTITY, async (user, upload) => {
      if (!upload.entityId) return false;
      const actor = await this.actors.resolve(user.id);
      const update = await this.prisma.progressUpdate.findUnique({
        where: { id: upload.entityId },
        select: {
          authorId: true,
          assignmentId: true,
          state: true,
          request: { select: { ownerId: true } },
        },
      });
      if (!update) return false;
      if (
        actor.staff?.permissions.has('progress.review') ||
        actor.staff?.permissions.has('issue.resolve')
      )
        return true;
      if (update.request.ownerId === user.id && update.state === 'approved')
        return true;
      if (
        update.authorId !== user.id ||
        !actor.platformRoles.includes('provider')
      )
        return false;
      const assignment = await this.prisma.assignment.findUnique({
        where: { id: update.assignmentId },
        select: { status: true },
      });
      return (
        !!assignment &&
        new Set<string>(ACCESSIBLE_ASSIGNMENTS).has(assignment.status)
      );
    });

    this.access.register(ISSUE_ENTITY, async (user, upload) => {
      if (!upload.entityId) return false;
      const actor = await this.actors.resolve(user.id);
      const issue = await this.prisma.issue.findUnique({
        where: { id: upload.entityId },
        select: {
          request: {
            select: {
              ownerId: true,
              assignments: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: { providerUserId: true, status: true },
              },
            },
          },
        },
      });
      if (!issue) return false;
      if (
        actor.staff?.permissions.has('issue.resolve') ||
        actor.staff?.permissions.has('progress.review')
      )
        return true;
      if (issue.request.ownerId === user.id) return true;
      const current = issue.request.assignments[0];
      return (
        actor.platformRoles.includes('provider') &&
        current?.providerUserId === user.id &&
        new Set<string>(ACCESSIBLE_ASSIGNMENTS).has(current.status)
      );
    });

    this.access.register(NOSHOW_ENTITY, async (user, upload) => {
      if (!upload.entityId) return false;
      const actor = await this.actors.resolve(user.id);
      if (!actor.staff?.permissions.has('dispatch.manage')) return false;
      const noShow = await this.prisma.noShow.findUnique({
        where: { id: upload.entityId },
        select: { id: true },
      });
      return !!noShow;
    });
  }
}
