import {
  intakeFields,
  serviceLines,
} from '../../platform/catalog/service-lines';
import { effectiveDates } from '../projections/projection.helpers';
import type { DispatchRequest } from './eligibility';

export type DispatchRequestRow = {
  id: string;
  ownerId: string;
  service: string;
  districtId: string;
  cityId: string;
  startDate: string | null;
  details: unknown;
};

export type DispatchLocations = {
  districtName?: string | null;
  cityName?: string | null;
};

const asObject = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/**
 * The one place the eligibility input is assembled (C.6): the skill from the
 * service line's catalogue skill field (04 §4.9), the effective start and end
 * dates, and the district name staff see in an `area` exclusion. The dispatch
 * service, the cascade handler and staff runs all use it.
 */
export function buildDispatchRequest(
  row: DispatchRequestRow,
  locations: DispatchLocations,
): DispatchRequest {
  const details = asObject(row.details);
  const skillField = (
    intakeFields[row.service as (typeof serviceLines)[number]] ?? []
  ).find((field) => field.isSkill);
  const skillValue = skillField ? details[skillField.key] : null;
  const skill =
    (typeof skillValue === 'string' || typeof skillValue === 'number') &&
    String(skillValue)
      ? String(skillValue)
      : null;
  const dates = effectiveDates(row.service, row.startDate, details);
  return {
    id: row.id,
    ownerId: row.ownerId,
    service: row.service,
    skill,
    districtId: row.districtId,
    districtName: locations.districtName || 'this district',
    cityId: row.cityId,
    cityName: locations.cityName ?? null,
    effectiveStartDate: dates.effectiveStartDate,
    effectiveEndDate: dates.effectiveEndDate,
  };
}
