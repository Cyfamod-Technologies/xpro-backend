import {
  catalogRows,
  seededCatalog,
} from '../../platform/catalog/catalog.testkit';
import type { DispatchProvider } from '../domain/eligibility';

/** The seeded catalog as `tx.catalogService`, which `dispatchRequestFor` reads. */
export const catalogStub = () => ({
  findMany: jest.fn().mockResolvedValue(catalogRows(seededCatalog())),
});

/** An eligible Design provider covering `district-1`; override fields per test. */
export function dispatchProvider(
  id: string,
  patch: Partial<DispatchProvider> = {},
): DispatchProvider {
  return {
    id,
    userId: `user-${id}`,
    name: `Provider ${id}`,
    verification: 'approved',
    userStatus: 'active',
    reliabilityStatus: 'normal',
    serviceIds: ['svc:Design'],
    skillIds: { 'svc:Design': ['svc:Design/Architectural plan'] },
    serviceAreaIds: ['district-1'],
    available: true,
    capacity: 3,
    committedJobs: 0,
    workingHours: {
      mon: { start: '08:00', end: '17:00' },
      tue: { start: '08:00', end: '17:00' },
      wed: { start: '08:00', end: '17:00' },
      thu: { start: '08:00', end: '17:00' },
      fri: { start: '08:00', end: '17:00' },
    },
    timeOff: [],
    hasVerifiedCurrentBank: true,
    lastOfferedAt: null,
    experience: 5,
    reliability: { offers: 0, declines: 0, expiries: 0, noShows: 0 },
    earlierEndReasons: [],
    ...patch,
  };
}

/** A `service_requests` row as the dispatch code reads it. */
export const designRequestRow = {
  id: 'request-1',
  ownerId: 'customer-1',
  service: 'Design',
  details: { designType: 'Architectural plan' },
  locationId: 'district-1',
  startDate: null as string | null,
  dispatchMode: 'auto',
  autoAttempts: 0,
  needsAssignmentReason: null as string | null,
  shareOnConfirm: { description: true, attachmentIds: [] as string[] },
};
