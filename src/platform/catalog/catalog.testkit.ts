import {
  hireTradeGroups,
  serviceSkills,
} from '../../scripts/legacy-service-catalog';
import type {
  CatalogIndex,
  CatalogNode,
  CatalogQuestion,
  ResolvedService,
} from './catalog.types';
import { inheritedQuestions, pathTo } from './catalog.tree';

export function makeQuestion(
  over: Partial<CatalogQuestion> & Pick<CatalogQuestion, 'serviceId' | 'key'>,
): CatalogQuestion {
  const type = over.type ?? 'short_text';
  return {
    id: `q:${over.serviceId}:${over.key}`,
    label: over.key,
    helpText: null,
    type,
    required: false,
    sortOrder: 0,
    active: true,
    options: [],
    config: {},
    dateRole: null,
    sensitive: false,
    matchesSkill: false,
    version: 1,
    ...over,
  };
}

export function makeNode(
  over: Partial<Omit<CatalogNode, 'questions'>> &
    Pick<CatalogNode, 'id' | 'name'> & {
      questions?: Array<
        Partial<CatalogQuestion> & Pick<CatalogQuestion, 'key'>
      >;
    },
): CatalogNode {
  const { questions = [], ...rest } = over;
  return {
    parentId: null,
    description: null,
    icon: null,
    depth: 0,
    sortOrder: 0,
    active: true,
    requiresStartDate: false,
    version: 1,
    children: [],
    ...rest,
    questions: questions.map((item, index) =>
      makeQuestion({ serviceId: over.id, sortOrder: index, ...item }),
    ),
  };
}

export const choice = (id: string, labels: readonly string[]) =>
  labels.map((label) => ({ id: `${id}:${label}`, label, active: true }));

export function indexOf(roots: CatalogNode[]): CatalogIndex {
  const byId = new Map<string, CatalogNode>();
  const visit = (node: CatalogNode) => {
    byId.set(node.id, node);
    node.children.forEach(visit);
  };
  roots.forEach(visit);
  return { roots, byId };
}

export function resolvedFor(
  catalog: CatalogIndex,
  id: string,
): ResolvedService {
  const path = pathTo(catalog, id);
  return { path, questions: inheritedQuestions(path) };
}

function root(
  name: string,
  children: string[],
  questions: Array<Omit<Parameters<typeof makeQuestion>[0], 'serviceId'>>,
  over: Partial<CatalogNode> = {},
): CatalogNode {
  const id = `svc:${name}`;
  return makeNode({
    id,
    name,
    ...over,
    questions: questions.map((item) => ({ ...item, serviceId: id })),
    children: children.map((child, index) =>
      makeNode({
        id: `svc:${name}/${child}`,
        name: child,
        parentId: id,
        depth: 1,
        sortOrder: index,
      }),
    ),
  });
}

/** The catalog the seed migration creates, with readable ids like `svc:Hire/Professional`. */
export function seededCatalog(): CatalogIndex {
  const hire = root(
    'Hire',
    Object.keys(hireTradeGroups),
    [
      {
        key: 'quantity',
        label: 'Quantity',
        type: 'number',
        required: true,
        config: { min: 1, max: 10, integer: true },
      },
      {
        key: 'endDate',
        label: 'Hire end date',
        type: 'date',
        required: true,
        dateRole: 'end',
      },
    ],
    { requiresStartDate: true },
  );
  const labels: Record<string, string> = {
    Professional: 'Professional required',
    'Vocational worker': 'Trade required',
    'Heavy equipment': 'Equipment required',
  };
  for (const child of hire.children) {
    const group = child.name as keyof typeof hireTradeGroups;
    child.questions = [
      makeQuestion({
        serviceId: child.id,
        key: 'trade',
        label: labels[group],
        type: 'single_choice',
        required: true,
        matchesSkill: true,
        options: choice(`${child.id}:trade`, hireTradeGroups[group]),
      }),
      ...(group === 'Heavy equipment'
        ? [
            makeQuestion({
              serviceId: child.id,
              key: 'operator',
              label: 'Operator required?',
              type: 'yes_no',
              sortOrder: 1,
            }),
          ]
        : []),
    ];
  }
  const roots = [
    root('Design', serviceSkills.Design, [
      {
        key: 'delivery',
        label: 'Project delivery',
        type: 'single_choice',
        required: true,
        options: choice('delivery', [
          'Design only',
          'Design and build with XPro',
        ]),
      },
    ]),
    root('Construction', serviceSkills.Construction, [
      {
        key: 'area',
        label: 'Approximate area (sqm)',
        type: 'number',
        config: { min: 0, exclusiveMinimum: true },
      },
    ]),
    hire,
    root('Procurement', serviceSkills.Procurement, [
      {
        key: 'materials',
        label: 'Materials and quantities required',
        type: 'long_text',
        required: true,
        config: { minLength: 5, maxLength: 2000 },
      },
      {
        key: 'brands',
        label: 'Preferred brands',
        type: 'short_text',
        config: { maxLength: 500 },
        sortOrder: 1,
      },
      {
        key: 'deliveryDate',
        label: 'Required delivery date',
        type: 'date',
        required: true,
        dateRole: 'start',
        sortOrder: 2,
      },
    ]),
    root('Facility management', serviceSkills['Facility management'], [
      {
        key: 'propertyType',
        label: 'Property type',
        type: 'single_choice',
        required: true,
        options: choice('propertyType', [
          'Residential',
          'Commercial',
          'Industrial',
        ]),
      },
      {
        key: 'visitDate',
        label: 'Preferred visit date',
        type: 'date',
        dateRole: 'start',
        sortOrder: 1,
      },
    ]),
    root('Waste management', serviceSkills['Waste management'], [
      {
        key: 'quantity',
        label: 'Estimated quantity and unit',
        type: 'short_text',
        required: true,
        config: { minLength: 2, maxLength: 200 },
      },
      {
        key: 'access',
        label: 'Pickup access instructions',
        type: 'long_text',
        required: true,
        sensitive: true,
        config: { minLength: 5, maxLength: 1000 },
        sortOrder: 1,
      },
      {
        key: 'pickupDate',
        label: 'Preferred pickup date',
        type: 'date',
        required: true,
        dateRole: 'start',
        sortOrder: 2,
      },
    ]),
  ];
  roots.forEach((node, index) => (node.sortOrder = index));
  return indexOf(roots);
}

/** Rows shaped like `catalogService.findMany({ include: CATALOG_INCLUDE })`. */
export function catalogRows(catalog: CatalogIndex) {
  return [...catalog.byId.values()].map((node) => ({
    ...node,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    questions: node.questions.map((question) => ({
      ...question,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    })),
  }));
}
