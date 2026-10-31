import { Injectable } from '@nestjs/common';
import type { RequestUser } from '../common/types/request-user';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { ActorService } from '../platform/actor/actor.service';
import { requirePermission } from '../platform/actor/actor.guards';
import { AppError } from '../platform/errors/app-error';
import { SettingsService } from '../platform/settings/settings.service';
import { PrismaService } from '../prisma/prisma.service';
import type { SetCustomerRequestLimitDto } from './dto/customer-request-limit.dto';
import {
  loadCustomerRequestLimit,
  type CustomerRequestLimit,
} from './open-request-limit';

export const REQUEST_LIMIT_RANGE_MESSAGE =
  'Choose a limit from 1 to 50, or leave it empty to use the default.';
export const REQUEST_LIMIT_NOTE_MESSAGE =
  'Add a note explaining why this limit changes.';
export const CUSTOMER_NOT_FOUND_MESSAGE = 'This customer was not found.';
export const CUSTOMER_REQUEST_LIMIT_AUDIT = 'Customer request limit changed';

const invalid = (message: string, field: string) =>
  new AppError(422, 'VALIDATION_ERROR', message, { field });

@Injectable()
export class CustomerRequestLimitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
    private readonly settings: SettingsService,
    private readonly audit: AuditLogsService,
  ) {}

  /** 04 §11.2 `PUT /admin/customers/:userId/request-limit` (MS-7). */
  async set(
    user: RequestUser,
    userId: string,
    dto: SetCustomerRequestLimitDto,
  ): Promise<CustomerRequestLimit> {
    const actor = await this.actors.resolve(user.id);
    requirePermission(actor, 'account.limit');

    const limit: unknown = dto.limit;
    if (
      limit !== null &&
      !(
        typeof limit === 'number' &&
        Number.isInteger(limit) &&
        limit >= 1 &&
        limit <= 50
      )
    )
      throw invalid(REQUEST_LIMIT_RANGE_MESSAGE, 'limit');
    const note = typeof dto.note === 'string' ? dto.note.trim() : '';
    if (note.length < 5 || note.length > 500)
      throw invalid(REQUEST_LIMIT_NOTE_MESSAGE, 'note');

    const target = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        openRequestLimit: true,
        platformRoles: { select: { role: true } },
      },
    });
    const roles = target?.platformRoles.map(({ role }) => role) ?? [];
    if (!target || !roles.includes('customer') || roles.includes('staff'))
      throw new AppError(404, 'NOT_FOUND', CUSTOMER_NOT_FOUND_MESSAGE);

    const before = target.openRequestLimit;
    await this.prisma.user.update({
      where: { id: userId },
      data: { openRequestLimit: limit },
    });
    this.audit.record({
      actorType: 'staff',
      actorId: actor.userId,
      entityType: 'user',
      entityId: userId,
      action: CUSTOMER_REQUEST_LIMIT_AUDIT,
      metadata: { before: { limit: before }, after: { limit }, note },
    });

    const settings = Object.fromEntries(
      (await this.settings.snapshot()).map(({ key, value }) => [key, value]),
    );
    return loadCustomerRequestLimit(this.prisma, userId, settings);
  }
}
