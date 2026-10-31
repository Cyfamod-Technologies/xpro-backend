import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { RequestUser } from '../common/types/request-user';
import { ActorService } from '../platform/actor/actor.service';
import { loadCatalog } from '../platform/catalog/catalog.tree';
import { IdempotencyService } from '../platform/idempotency/idempotency.service';
import { RequestCommandRunner } from './command-runner';
import {
  checkGroupServices,
  checkNoProjectFiles,
  childTitle,
  formatGroupRef,
  intakeFieldPath,
  servicesLimit,
  withFieldPath,
} from './domain/request-group';
import {
  validateIntake,
  type IntakeLocation,
  type IntakeValidationInput,
  type ValidatedIntake,
} from './domain/intake-validation';
import { resolveServiceInput } from './domain/legacy-service-input';
import type { RequestDetailDto } from './dto/request-detail.dto';
import type { RequestGroupCreateDto } from './dto/request-group.dto';
import { IntakeService } from './intake.service';
import { enforceOpenRequestLimit } from './open-request-limit';

export type RequestGroupCreated = {
  group: { id: string; ref: string; title: string } | null;
  requests: RequestDetailDto[];
  warnings?: Array<{ requestId: string; message: string }>;
};

type Prepared = {
  index: number;
  valid: ValidatedIntake;
  fieldOf: (message: string) => string | null;
};

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

@Injectable()
export class RequestGroupsService {
  constructor(
    private readonly actors: ActorService,
    private readonly runner: RequestCommandRunner,
    private readonly idempotency: IdempotencyService,
    private readonly intake: IntakeService,
  ) {}

  /** 04 §6.2 `POST /request-groups`: every service becomes an ordinary request, or none does. */
  async create(
    user: RequestUser,
    dto: RequestGroupCreateDto,
    key: string,
    originalUrl: string,
  ): Promise<{ status: number; body: RequestGroupCreated }> {
    const actor = await this.actors.resolve(user.id);
    this.intake.requireActiveCustomer(actor);
    const hash = this.idempotency.hashRequest('POST', originalUrl, dto);
    return this.runner.createBundle<RequestGroupCreated>(
      { actor, idempotencyKey: key, idempotencyHash: hash },
      async (tx, now, settings, createChild) => {
        checkGroupServices(dto.services, servicesLimit(settings));
        checkNoProjectFiles(dto.attachments);
        const locations = await tx.location.findMany({
          where: { active: true },
          select: { id: true, kind: true, parentId: true, active: true },
        });
        const catalog = await loadCatalog(tx);
        const prepared = dto.services.map((item, index) =>
          this.prepare(dto, item, index, catalog, locations, now),
        );
        await enforceOpenRequestLimit(tx, user.id, settings, prepared.length);
        const projectTitle = prepared[0].valid.title;
        const grouped = prepared.length > 1;
        const group = grouped
          ? await this.insertGroup(tx, user.id, projectTitle)
          : null;

        const requests: RequestDetailDto[] = [];
        const warnings: NonNullable<RequestGroupCreated['warnings']> = [];
        const createdIds: string[] = [];
        for (const { index, valid, fieldOf } of prepared) {
          let inserted: { warning?: string; duplicateRef?: string } = {};
          const titled = grouped
            ? {
                ...valid,
                title: childTitle(
                  valid.title,
                  valid.servicePath[valid.servicePath.length - 1].name,
                ),
              }
            : valid;
          const created = await createChild(
            async (childTx) => {
              try {
                const result = await this.intake.insertValidated(
                  childTx,
                  {
                    userId: user.id,
                    displayName: actor.displayName,
                    now,
                    settings,
                  },
                  titled,
                  group
                    ? { id: group.id, position: index, siblingIds: createdIds }
                    : undefined,
                );
                inserted = result;
                return result.id;
              } catch (error) {
                const message =
                  error instanceof Error ? error.message : undefined;
                throw withFieldPath(error, message ? fieldOf(message) : null);
              }
            },
            (context) => {
              const outcome = this.intake.recordCreated(
                context,
                inserted,
                group?.id,
              );
              if (group && index === 0)
                context.notify('request.group_received', {
                  count: prepared.length,
                  projectTitle,
                });
              return Promise.resolve(outcome);
            },
          );
          createdIds.push(created.id);
          requests.push(created.body);
          if (created.warning)
            warnings.push({
              requestId: created.body.id,
              message: created.warning,
            });
        }
        return {
          group: group
            ? { id: group.id, ref: group.ref, title: group.title }
            : null,
          requests,
          ...(warnings.length ? { warnings } : {}),
        };
      },
    );
  }

  private prepare(
    dto: RequestGroupCreateDto,
    item: unknown,
    index: number,
    catalog: Awaited<ReturnType<typeof loadCatalog>>,
    locations: readonly IntakeLocation[],
    now: Date,
  ): Prepared {
    const service = record(item);
    const providerField =
      (
        [
          [
            service.preferredProviderId,
            `services[${index}].preferredProviderId`,
          ],
          [service.providerId, `services[${index}].providerId`],
          [dto.preferredProviderId, 'preferredProviderId'],
          [dto.providerId, 'providerId'],
        ] as const
      ).find(([value]) => value !== undefined)?.[1] ?? 'providerId';
    const input: IntakeValidationInput = {
      title: dto.title,
      serviceId: service.serviceId,
      cityId: dto.cityId,
      districtId: dto.districtId,
      address: dto.address,
      phone: dto.phone,
      contactMethod: dto.contactMethod,
      description: service.description,
      budget: service.budget,
      startDate: service.startDate,
      answers: service.answers,
      attachments: service.attachments,
      preferredProviderId:
        service.preferredProviderId ?? dto.preferredProviderId,
      providerId: service.providerId ?? dto.providerId,
    };
    const resolved = resolveServiceInput(catalog, input);
    const fieldOf = (message: string) =>
      intakeFieldPath(message, {
        index,
        title: dto.title,
        address: dto.address,
        providerField,
        questions: resolved?.questions ?? [],
      });
    try {
      return {
        index,
        valid: validateIntake(input, resolved, locations, now),
        fieldOf,
      };
    } catch (error) {
      throw withFieldPath(
        error,
        error instanceof Error ? fieldOf(error.message) : null,
      );
    }
  }

  private async insertGroup(
    tx: Prisma.TransactionClient,
    ownerId: string,
    title: string,
  ) {
    const [{ nextval }] = await tx.$queryRaw<Array<{ nextval: bigint }>>(
      Prisma.sql`SELECT nextval('request_group_ref_seq') AS nextval`,
    );
    return tx.requestGroup.create({
      data: { ownerId, title, ref: formatGroupRef(nextval) },
      select: { id: true, ref: true, title: true },
    });
  }
}
