import {
  loadCatalog,
  pathTo,
  type CatalogDb,
} from '../../platform/catalog/catalog.tree';
import type { CatalogIndex } from '../../platform/catalog/catalog.types';
import { idsFromNames } from '../../platform/catalog/provider-skills';
import { effectiveDates, jsonObject } from '../projections/projection.helpers';
import { answerSnapshots, snapshotSkill } from './answers';
import type { DispatchRequest } from './eligibility';
import { legacySkill } from './legacy-service-input';

export type DispatchRequestRow = {
  id: string;
  ownerId: string;
  service: string;
  serviceId?: string | null;
  locationId: string;
  startDate: string | null;
  details: unknown;
  answers?: unknown;
  servicePath?: unknown;
};

export type DispatchLocations = {
  /** The chosen place and its ancestors, root first. */
  locationPath?: ReadonlyArray<{ id: string; name: string }> | null;
};

export function storedSkill(
  row: Pick<
    DispatchRequestRow,
    'service' | 'serviceId' | 'answers' | 'servicePath'
  >,
  details: Record<string, unknown>,
): string | null {
  const answers = answerSnapshots(row.answers);
  if (!row.serviceId) return legacySkill(row.service, details);
  const answered = snapshotSkill(answers)?.value;
  if (typeof answered === 'string' && answered) return answered;
  const path = Array.isArray(row.servicePath) ? row.servicePath : [];
  const leaf =
    path.length > 1 ? (path[path.length - 1] as { name?: unknown }) : null;
  return typeof leaf?.name === 'string' ? leaf.name : null;
}

type ServiceSkill = Pick<
  DispatchRequest,
  'service' | 'serviceId' | 'skill' | 'skillId'
>;

function liveService(
  row: DispatchRequestRow,
  catalog: CatalogIndex,
): ServiceSkill | null {
  const path = row.serviceId ? pathTo(catalog, row.serviceId) : [];
  if (!path.length) return null;
  const answer = snapshotSkill(answerSnapshots(row.answers));
  const question = answer
    ? path
        .flatMap(({ questions }) => questions)
        .find(({ id }) => id === answer.questionId)
    : undefined;
  const option = question?.options.find(
    ({ id }) => id === answer?.optionIds?.[0],
  );
  const leaf = path[path.length - 1];
  return {
    service: path[0].name,
    serviceId: path[0].id,
    skill:
      option?.label ??
      (typeof answer?.value === 'string' ? answer.value : null) ??
      (leaf.depth >= 1 ? leaf.name : null),
    skillId: option?.id ?? (!answer && leaf.depth >= 1 ? leaf.id : null),
  };
}

function storedService(
  row: DispatchRequestRow,
  details: Record<string, unknown>,
  catalog?: CatalogIndex,
): ServiceSkill {
  const skill = storedSkill(row, details);
  if (!catalog)
    return { service: row.service, serviceId: null, skill, skillId: null };
  const { serviceIds, skillIds } = idsFromNames(catalog, [row.service], {
    [row.service]: skill ? [skill] : [],
  });
  const serviceId = serviceIds[0] ?? null;
  return {
    service: row.service,
    serviceId,
    skill,
    skillId: serviceId ? (skillIds[serviceId]?.[0] ?? null) : null,
  };
}

function dispatchLocation(
  locationId: string,
  locations: DispatchLocations,
): Pick<
  DispatchRequest,
  'locationId' | 'locationName' | 'locationIds' | 'locationParentId'
> {
  const path = locations.locationPath ?? [];
  const index = path.findIndex(({ id }) => id === locationId);
  const ancestors = index > 0 ? path.slice(0, index) : [];
  return {
    locationId,
    locationName: (index >= 0 && path[index].name) || 'this area',
    locationIds: [locationId, ...ancestors.map(({ id }) => id)],
    locationParentId: ancestors.at(-1)?.id ?? null,
  };
}

export async function dispatchRequestFor(
  db: CatalogDb,
  row: DispatchRequestRow,
  locations: DispatchLocations,
): Promise<DispatchRequest> {
  return buildDispatchRequest(row, locations, await loadCatalog(db));
}

/**
 * The one place the eligibility input is assembled (C.6): the root service and
 * skill, as names and ids, from the live catalog by id (04 §4.9), the
 * effective start and end dates, and the place name staff see in an `area`
 * exclusion. Rows without a `serviceId`, or whose path no longer resolves,
 * resolve the stored service name and details to ids. The
 * dispatch service, the cascade handler and staff runs all use it.
 */
export function buildDispatchRequest(
  row: DispatchRequestRow,
  locations: DispatchLocations,
  catalog?: CatalogIndex,
): DispatchRequest {
  const details = jsonObject(row.details);
  const resolved =
    (catalog && liveService(row, catalog)) ??
    storedService(row, details, catalog);
  const dates = effectiveDates(
    row.service,
    row.startDate,
    details,
    row.answers,
  );
  return {
    id: row.id,
    ownerId: row.ownerId,
    ...resolved,
    ...dispatchLocation(row.locationId, locations),
    effectiveStartDate: dates.effectiveStartDate,
    effectiveEndDate: dates.effectiveEndDate,
  };
}
