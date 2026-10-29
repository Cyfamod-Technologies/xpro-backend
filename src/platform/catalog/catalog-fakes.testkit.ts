import { catalogRows, seededCatalog } from './catalog.testkit';
import type { CatalogIndex } from './catalog.types';
import { CatalogQuestionService } from './catalog-question.service';
import { CatalogService } from './catalog.service';

export type FakeOptions = {
  catalog?: CatalogIndex;
  maxDepth?: number;
  requests?: number;
  profiles?: Array<Record<string, unknown>>;
  permissions?: string[];
};

/** In-memory stand-ins for the Prisma client and collaborators the catalog services use. */
export function fakeCatalog(options: FakeOptions = {}) {
  const catalog = options.catalog ?? seededCatalog();
  const questions = () =>
    [...catalog.byId.values()].flatMap((node) => node.questions);
  const tx = {
    $executeRaw: jest.fn(),
    catalogService: {
      findMany: jest.fn(() => Promise.resolve(catalogRows(catalog))),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'new-service', ...data }),
      ),
      update: jest.fn(
        (_args: { where: { id: string }; data: Record<string, unknown> }) =>
          Promise.resolve(),
      ),
      delete: jest.fn(),
    },
    serviceQuestion: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'new-question',
          helpText: null,
          dateRole: null,
          version: 1,
          ...data,
        }),
      ),
      update: jest.fn(
        ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const { version, ...rest } = data;
          void version;
          const existing = questions().find(({ id }) => id === where.id)!;
          return Promise.resolve({
            ...existing,
            ...rest,
            version: existing.version + 1,
          });
        },
      ),
      delete: jest.fn(),
    },
    serviceRequest: {
      count: jest.fn(() => Promise.resolve(options.requests ?? 0)),
      groupBy: jest.fn(() => Promise.resolve([])),
    },
    setting: {
      findUnique: jest.fn(() =>
        Promise.resolve(
          options.maxDepth === undefined ? null : { value: options.maxDepth },
        ),
      ),
    },
    providerProfile: {
      findMany: jest.fn(() => Promise.resolve(options.profiles ?? [])),
      update: jest.fn(),
    },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn((run: (client: typeof tx) => unknown) => run(tx)),
  };
  const actors = {
    resolve: jest.fn(() =>
      Promise.resolve({
        userId: 'staff-1',
        kind: 'staff',
        displayName: 'Staff',
        platformRoles: ['staff'],
        accountActive: true,
        staff: {
          status: 'active',
          roles: [],
          permissions: new Set(options.permissions ?? ['catalog.manage']),
          canOwn: false,
          isSuperAdmin: false,
          permVersion: 1,
        },
      }),
    ),
  };
  const audit = { record: jest.fn() };
  const settings = {
    snapshot: jest.fn(() =>
      Promise.resolve([
        {
          key: 'catalog.maxDepth',
          value: options.maxDepth ?? 2,
          version: 4,
        },
      ]),
    ),
    save: jest.fn(),
  };
  const service = new CatalogService(
    prisma as never,
    actors as never,
    audit as never,
    settings as never,
  );
  const questionService = new CatalogQuestionService(prisma as never, service);
  return { catalog, tx, prisma, audit, settings, service, questionService };
}
