import { Injectable, OnModuleInit } from '@nestjs/common';
import { ActorService } from '../platform/actor/actor.service';
import { PrismaService } from '../prisma/prisma.service';
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
    this.access.register('request', async (user: RequestUser, upload) => {
      if (!upload.entityId) return false;
      const actor = await this.actors.resolve(user.id);
      const request = await this.prisma.serviceRequest.findUnique({
        where: { id: upload.entityId },
        select: {
          ownerId: true,
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

    this.access.register('message', async (user, upload) => {
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
        if (actor.kind === 'customer')
          return message.request.ownerId === user.id;
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
      if (actor.kind !== 'provider' || !message.providerId) return false;
      const current = message.request.assignments[0];
      return (
        current?.providerId === message.providerId &&
        current.providerUserId === user.id &&
        ACCESSIBLE_ASSIGNMENTS.includes(
          current.status as (typeof ACCESSIBLE_ASSIGNMENTS)[number],
        )
      );
    });
  }
}
