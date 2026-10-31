import type { DateRole, QuestionType } from '@prisma/client';

export type SeedService = {
  id: string;
  name: string;
  /** Set on create and on every apply. */
  description?: string;
  /** Set only when the node is created, so a later admin edit is never reverted. */
  initialDescription?: string;
  requiresStartDate?: boolean;
  children?: SeedService[];
};

export type SeedQuestion = {
  id: string;
  serviceId: string;
  key: string;
  label: string;
  type: QuestionType;
  required: boolean;
  sortOrder: number;
  options: Array<{ id: string; label: string; active: boolean }>;
  config: Record<string, unknown>;
  dateRole: DateRole | null;
  sensitive: boolean;
};

/**
 * The target catalog, in display order: a node's position among its siblings is
 * its sort order. Ids are fixed (uuid v5 of `xpro:catalog:<path>`), so every
 * environment ends up with the same ids. The Hiring trades reuse the ids of the
 * options they replace, so provider skill ids stay valid.
 */
export const CATALOG_SERVICES: SeedService[] = [
  {
    id: '9b9a8d11-1573-5e55-b6a3-2a0a242a1a17',
    name: 'Design',
    initialDescription: 'Architectural, structural and interior plans.',
    children: [
      {
        id: '63aee96a-de60-56f4-b5d7-38f1ea5676c0',
        name: 'Architectural Designs',
        description:
          'Full building plans from concept to construction-ready drawings, tailored to your site and your brief.',
      },
      {
        id: '26c27126-bf83-508a-bef1-02a20cc8d741',
        name: 'Interior Designs',
        description:
          'Space planning and high-end interior finishing concepts for residential and commercial interiors alike.',
      },
      {
        id: 'df5f44e2-8043-5fd3-b79f-0b3dd658214a',
        name: 'Structural Designs',
        description:
          'Engineering plans that keep your build safe, compliant, and built to last, from foundation to roofline.',
      },
    ],
  },
  {
    id: 'e7d44a80-1de0-57a0-ba41-2bf724259b60',
    name: 'Construction',
    initialDescription: 'Construction, finishes and renovation.',
    children: [
      {
        id: '8c136806-c53c-51c7-b585-031700b7b99f',
        name: 'Floor Finishing',
        children: [
          {
            id: '16556847-4140-5b9b-b164-b753a5abb092',
            name: 'Tiling',
          },
          {
            id: '5289c0b1-ac91-5f54-afd3-56f77318c431',
            name: 'Concrete Paving/Interlocking',
          },
          {
            id: '7d1d20ee-987f-52c9-b356-fb0e8e01cfb2',
            name: 'Wood Floor Covering & Epoxy',
          },
          {
            id: '1e642cf8-3483-5d3f-8820-a52a7c540394',
            name: 'Asphalt Covering',
          },
          {
            id: '85c69485-5c47-554c-8ea6-e88c7b1f61c4',
            name: 'Gabion Flooring',
          },
          {
            id: 'ccc190c1-9932-5168-a3f9-ed72f4991215',
            name: 'Skirting Installation',
          },
        ],
      },
      {
        id: 'f9cc068d-891c-5ba4-a6b6-775610a458b3',
        name: 'Wall Finishing',
        children: [
          {
            id: '7eadf50a-1d79-5791-8049-45977cb0a0a0',
            name: 'Plastering (optional waterproofing)',
          },
          {
            id: 'd7bb25d7-5445-537a-a64b-1a8b8381ef6a',
            name: 'Wall Screeding',
          },
          {
            id: '720e2834-5ad2-55d4-8ddf-e51ed8b6bab7',
            name: '3D Wall Panel',
          },
          {
            id: '138b89ba-b2ec-59ba-b4c7-09af073da74f',
            name: 'Painting',
          },
          {
            id: '2deb7355-280d-5cb5-b771-c49365f28b1a',
            name: 'Gabion & Alumaco Wall',
          },
          {
            id: '747cbf71-c713-54b1-9c03-7f497dc6a527',
            name: 'Textured Wall Finishes',
          },
        ],
      },
      {
        id: '1de37fcc-fb5a-5bc2-8374-102c7c71023c',
        name: 'Ceiling Finishing',
        children: [
          {
            id: 'bb02ac56-fe74-5f03-a47b-cdf4566acbfb',
            name: 'Plaster Boarding',
          },
          {
            id: 'c17b0330-8a8f-5b2c-9e17-ce70a6a6ec97',
            name: 'Plaster of Paris Moulding (POP)',
          },
          {
            id: '8e16b57e-5ab7-5cdb-8ab0-550af55d77ad',
            name: 'Profile Light Aluminium',
          },
          {
            id: '361a4e54-1019-55bb-9d24-34896ce722b5',
            name: 'Synthetic Slates/Tiling',
          },
          {
            id: '61985ebe-cb8a-55d6-b810-892a8af0e91a',
            name: 'Suspended Ceiling',
          },
          {
            id: '307e9fbc-8a4d-52e8-ba2d-057bd2455a13',
            name: 'Ceiling Cornices',
          },
        ],
      },
      {
        id: '327785d5-940f-5cbe-ad84-90a883adef38',
        name: 'Roof Finishing',
        children: [
          {
            id: 'ee65cf1d-a35d-532a-a4b2-9c54176f8fba',
            name: 'Light Weight Metallic',
          },
          {
            id: '36080d1a-264d-5bf7-bb7d-5d8e82d66c2b',
            name: 'EPDM Rubber/Waterproofing',
          },
          {
            id: '1c4d4322-f6c4-5cfd-8bf4-395493925233',
            name: 'Asphalt Shingle',
          },
          {
            id: 'a3e7b265-6473-5a88-9b53-1adf4589180e',
            name: 'Water Collector Installation',
          },
          {
            id: '4e996e2e-983e-5b69-8527-78b8efdd122c',
            name: 'Aluminium Roofing Sheets',
          },
          {
            id: 'bda0d1f9-1371-55fa-a7a9-8220407bd6df',
            name: 'Roof Insulation',
          },
        ],
      },
      {
        id: '29817a60-299d-59e8-b7b3-545cc6aae38a',
        name: 'Final Finishing',
        children: [
          {
            id: 'e95168a4-fc0c-5f07-a557-cee056e5f912',
            name: 'Interior Decoration & Furniture',
          },
          {
            id: 'a06ac3d7-f3cd-58cb-9a5c-e03540afd79d',
            name: 'Windows & Doors',
          },
          {
            id: 'd916484a-2cdf-5e2e-a2e4-9a8ac1ae7494',
            name: 'Electrical & HVAC',
          },
          {
            id: '79fcc0f9-5bf5-5a44-803b-fb7242d9a8e0',
            name: 'Smart Home Automation',
          },
          {
            id: 'caaa4a10-9265-5193-ae76-eaca9dee17a7',
            name: 'Landscaping',
          },
          {
            id: 'eee61672-244c-545f-9b76-1af61ccce35c',
            name: 'Renovation & Demolition',
          },
        ],
      },
      {
        id: 'ebe0f40b-832d-5ffd-bf4e-e818685d3996',
        name: 'Facade Finishing',
        children: [
          {
            id: '1c93d38b-7478-5d4d-8fbf-f98b9d28043b',
            name: 'Cladding',
          },
          {
            id: 'e1792bec-543d-527e-8d47-d040d1ce7b8b',
            name: 'External Rendering',
          },
          {
            id: 'f7c2c402-5228-585a-92bd-223f93fa4839',
            name: 'Exterior Paint & Protective Coating',
          },
          {
            id: 'df3b1dfd-cdf2-57b7-9d10-41ba667f0d8e',
            name: 'Curtain Walling',
          },
          {
            id: 'd66901bb-04ff-5dbc-8650-c200fa6daec6',
            name: 'Stone/Brick Veneer',
          },
          {
            id: '760aec2c-4ff0-5131-8827-0c5c6e08da4d',
            name: 'Weatherproofing Sealant',
          },
        ],
      },
    ],
  },
  {
    id: '0571b359-ca19-53fd-bcc0-c9ffa95ee362',
    name: 'Hiring',
    initialDescription: 'Professionals, trades and heavy equipment.',
    requiresStartDate: true,
    children: [
      {
        id: '32198424-4d1c-5fc4-a84b-a24f5026dc1c',
        name: 'Professionals',
        children: [
          {
            id: 'c1bdc4a3-3224-50fb-81f9-8be0e05be9b7',
            name: 'Architect',
          },
          {
            id: '7ae6a5b3-7163-5753-9201-ba908e595767',
            name: 'Interior Designer',
          },
          {
            id: 'cea49076-cc45-500a-ac57-e555225162df',
            name: 'Civil/Structural Engineer',
          },
          {
            id: '768cd784-0925-51e5-a822-2e9e8ef9e237',
            name: 'Builder',
          },
          {
            id: '98770bba-72fa-5c28-9eb4-33f6f5ec817f',
            name: 'Quantity Surveyor',
          },
          {
            id: '51f1e57e-60a4-52ae-824f-bfac3b84b3d8',
            name: 'Land Surveyor',
          },
          {
            id: 'e99bdfd3-dc06-525e-93b9-e070367a44a3',
            name: 'Project Manager',
          },
          {
            id: '5a6a1af1-cc02-5155-87dc-4d72950856dd',
            name: 'MEP Engineer',
          },
          {
            id: '0a8d3f2d-42e9-5cdd-a1a2-54f0ebd8ad13',
            name: 'Site Engineer',
          },
          {
            id: '46e506e4-e35a-5502-9ec9-5b5d96282ec2',
            name: 'Safety Officer (HSE)',
          },
          {
            id: 'fc85fc6a-d61c-547e-a4a3-661ebbba301b',
            name: 'Cost Estimator',
          },
          {
            id: 'c7a6ce92-250c-5e7a-9ba1-0126d7a53490',
            name: 'Draftsman/CAD Technician',
          },
          {
            id: '4eca366a-985d-5838-b4e9-d99c47bf6393',
            name: 'Geotechnical Engineer',
          },
          {
            id: '07a1fafa-f823-5b1c-b0af-b3d1d436ee3f',
            name: 'Landscape Architect',
          },
          {
            id: 'c49bf107-ec17-5bad-975d-e65c6d942c2a',
            name: 'Urban Planner',
          },
          {
            id: 'e0e00157-ef35-5501-9c5a-3efecd1a1708',
            name: 'Facilities Manager',
          },
          {
            id: 'd3de3feb-7236-5b87-a6eb-edd8bf9dff21',
            name: 'Environmental Engineer',
          },
          {
            id: 'f6f572ea-54e3-5134-a3a3-806ee7eb1342',
            name: 'Building Inspector',
          },
          {
            id: '91e44ba3-9094-52b7-b8a6-0f2246d9cb90',
            name: 'Procurement Officer',
          },
        ],
      },
      {
        id: '22c8794f-98ed-58b1-8e9c-ab9733f98b37',
        name: 'Vocational Workers',
        children: [
          {
            id: 'c9ccccad-3dbb-5175-8ab6-0edc446e867a',
            name: 'Mason',
          },
          {
            id: '4a80dd0d-dc6e-5781-a060-967c61898d61',
            name: 'Plumber',
          },
          {
            id: 'd39d5e76-da05-502c-bd39-f58899c5da4b',
            name: 'Electrician',
          },
          {
            id: '53482810-4404-5335-a070-db9b8e4bb178',
            name: 'Carpenter',
          },
          {
            id: '08dd57c0-54d4-5910-8ef9-2316dbe70b5f',
            name: 'Painter',
          },
          {
            id: '86fb9ed1-944b-598f-9504-49bdb94025ba',
            name: 'Wall Screeder',
          },
          {
            id: '63078862-1514-511d-a822-f7f54fee78ca',
            name: 'Gardener',
          },
          {
            id: 'eac247a9-a8d7-552e-bcf9-f6991fadbaf9',
            name: 'Heavy Equipment Operator',
          },
          {
            id: '6ae63215-4a6e-54a2-a4bf-ac6a2e4fc1c9',
            name: 'Direct Labourer',
          },
          {
            id: '76fd3d20-3ca1-598b-803c-1282eeb67f36',
            name: 'Welder',
          },
          {
            id: 'e6ca96d1-a09e-52ff-ab1e-6ed19cabf552',
            name: 'Tiler',
          },
          {
            id: '1b2da88b-2262-5e8a-b46c-1ce840913b42',
            name: 'Steel Fixer/Rebar Bender',
          },
          {
            id: '8cf44a4d-6de3-5103-a1c5-d35386c79a5c',
            name: 'Scaffolder',
          },
          {
            id: '8841e7f1-2516-5dc5-af7c-42dbe8579b77',
            name: 'Roofer',
          },
          {
            id: 'faed3d1a-8e6f-5dbc-8a6c-f38bcc4d4116',
            name: 'POP/Ceiling Installer',
          },
          {
            id: '85fdf6b3-a0d5-507b-aa53-213f3612c557',
            name: 'Glazier',
          },
          {
            id: '3d643c0a-6782-553e-a4a2-99e3f0f98e02',
            name: 'Bricklayer',
          },
          {
            id: '6495af83-1754-5ba9-883b-c833f9041236',
            name: 'Plasterer',
          },
          {
            id: 'ca9fca40-8769-5be0-97fc-cc0f074fd610',
            name: 'Aluminium Fabricator',
          },
          {
            id: 'a52729aa-f265-5175-aace-f5e350b14319',
            name: 'HVAC Technician',
          },
        ],
      },
      {
        id: 'cb7841ca-95b3-51e7-8cef-4159b9632b48',
        name: 'Heavy Equipment',
        children: [
          {
            id: '9f01193b-548c-52ca-abd3-09fe9da83e52',
            name: 'Concrete Mixer',
          },
          {
            id: '28a00721-6bf9-5b6a-90a1-7d70b7804c87',
            name: 'Concrete Vibrator',
          },
          {
            id: '0b5ec097-ea58-5969-a71f-208944c4b6f5',
            name: 'Trailers',
          },
          {
            id: '8f227508-fe64-5a3b-aed0-fefe79c0a027',
            name: 'Bulldozer',
          },
          {
            id: 'dad15ef5-8fd4-5630-8e9f-d710f2b2edc1',
            name: 'Crane',
          },
          {
            id: '15289b47-e961-5285-813b-e013e4bce6a9',
            name: 'Excavator',
          },
          {
            id: '98dbbd7e-fe24-5c06-976a-232d8bd48287',
            name: 'Loader',
          },
          {
            id: '4caba452-b79c-5a3a-a805-24b7d59b47dc',
            name: 'Grader',
          },
          {
            id: 'e72cef80-1bb0-5605-9394-00571dc69e41',
            name: 'Backhoe',
          },
          {
            id: '8e3d3724-f887-5471-bfb6-3b46ee51a4f5',
            name: 'Compactor',
          },
          {
            id: 'd7091df1-9c6d-56a7-952b-2a92db808883',
            name: 'Forklift',
          },
          {
            id: '4fec235b-ad8c-5b3e-882d-575cb4e609ba',
            name: 'Trencher',
          },
          {
            id: 'f18bc985-bc81-590b-a7d2-791679c46cc8',
            name: 'Skid-Steer Loader',
          },
          {
            id: 'd62c7586-fc30-5e5b-a230-941490877304',
            name: 'Telehandler',
          },
          {
            id: '022d2be8-1379-5911-ab55-9a7eda690d2e',
            name: 'Wheel Tractor',
          },
          {
            id: 'd390f5c2-4209-5080-a0c0-032f3ff0fa7f',
            name: 'Scraper',
          },
          {
            id: '1fafd87e-f2e4-57eb-998f-b7f2a1f33267',
            name: 'Paver',
          },
          {
            id: '28ba93dd-aa9d-59c1-a993-edf18f54837f',
            name: 'Feller Buncher',
          },
          {
            id: '435911f8-db7a-5339-9b1a-501f1a31217d',
            name: 'Dumper',
          },
        ],
      },
    ],
  },
  {
    id: '65647012-92b6-5f99-b688-77555f48778a',
    name: 'Facility Management',
    initialDescription: 'Maintenance and property support.',
    children: [
      {
        id: '51c086a8-2375-5f33-a46c-6616dcd3cb83',
        name: 'Cleaning & Janitorial',
      },
      {
        id: 'e33d7558-f7d3-5906-b9ba-3a0bc514705b',
        name: 'Building Maintenance & Repairs',
      },
      {
        id: 'f60c8ab0-2b61-59e1-b628-fa9e7c6da885',
        name: 'Security Services',
      },
      {
        id: 'fe714f61-372e-553d-90ba-6dbeaa8947b5',
        name: 'Landscaping & Grounds Keeping',
      },
      {
        id: '2ec42410-a2e9-5ef4-8fea-ff53a34b1b5d',
        name: 'Pest Control',
      },
      {
        id: 'd0a87600-b40d-5ec5-ad2a-afaf46b82197',
        name: 'HVAC Servicing & Maintenance',
      },
      {
        id: 'fc33ed4e-7c08-50a5-8298-68859b1b1245',
        name: 'Property/Facility Management',
      },
      {
        id: 'd94238ec-1d3a-56bf-b4e6-4760e47d6174',
        name: 'Facility Inspections & Reporting',
      },
    ],
  },
  {
    id: '9b8a5a40-bbb9-5595-a283-ce6d15d91841',
    name: 'Waste Management',
    initialDescription: 'Waste collection and site clearance.',
    children: [
      {
        id: '533cac93-fda2-5115-966a-ec4b8b1f3500',
        name: 'Residential',
      },
      {
        id: 'fc77b535-e77f-51b9-8cb2-638ca3c73a27',
        name: 'Commercial',
      },
      {
        id: 'f0d662a9-f935-5ac6-8438-7ddf2a9ef6ab',
        name: 'Construction debris',
      },
    ],
  },
];

/** Questions that stay. Created when missing; an existing question is never edited. */
export const CATALOG_QUESTIONS: SeedQuestion[] = [
  {
    id: '46756d14-0b56-5984-bee5-e53e4742a50d',
    serviceId: '9b9a8d11-1573-5e55-b6a3-2a0a242a1a17',
    key: 'delivery',
    label: 'Project delivery',
    type: 'single_choice',
    required: true,
    sortOrder: 0,
    options: [
      {
        id: 'd1beb089-9f6f-5559-a10e-46a8f9fd2b4c',
        label: 'Design only',
        active: true,
      },
      {
        id: '4b3b7e14-b31b-5c10-829f-b3f08c33d31c',
        label: 'Design and build with XPro',
        active: true,
      },
    ],
    config: {},
    dateRole: null,
    sensitive: false,
  },
  {
    id: '34f9915e-699b-53bc-b7b1-27da184930f6',
    serviceId: 'e7d44a80-1de0-57a0-ba41-2bf724259b60',
    key: 'area',
    label: 'Approximate area (sqm)',
    type: 'number',
    required: false,
    sortOrder: 0,
    options: [],
    config: {
      min: 0,
      exclusiveMinimum: true,
    },
    dateRole: null,
    sensitive: false,
  },
  {
    id: 'dad66dd1-2dc4-51df-bdd2-7f3dce49aba7',
    serviceId: '0571b359-ca19-53fd-bcc0-c9ffa95ee362',
    key: 'quantity',
    label: 'Quantity',
    type: 'number',
    required: true,
    sortOrder: 0,
    options: [],
    config: {
      min: 1,
      max: 10,
      integer: true,
    },
    dateRole: null,
    sensitive: false,
  },
  {
    id: '34ab0d17-1ab0-55c7-aba7-4ceca28b6409',
    serviceId: '0571b359-ca19-53fd-bcc0-c9ffa95ee362',
    key: 'endDate',
    label: 'Hire end date',
    type: 'date',
    required: true,
    sortOrder: 1,
    options: [],
    config: {},
    dateRole: 'end',
    sensitive: false,
  },
  {
    id: '6d6519d0-0243-5c32-9cb7-3a22ce088876',
    serviceId: '65647012-92b6-5f99-b688-77555f48778a',
    key: 'propertyType',
    label: 'Property type',
    type: 'single_choice',
    required: true,
    sortOrder: 0,
    options: [
      {
        id: '2baf8c2f-ed9e-5456-bae9-fb8e2adbc3df',
        label: 'Residential',
        active: true,
      },
      {
        id: '7bb6d186-de06-5c7a-814a-a858efdc1cb5',
        label: 'Commercial',
        active: true,
      },
      {
        id: 'e608e6ab-ad89-5830-8ed6-5c5519d37579',
        label: 'Industrial',
        active: true,
      },
    ],
    config: {},
    dateRole: null,
    sensitive: false,
  },
  {
    id: 'bd1582f2-6c90-5461-a233-6c7a85365d99',
    serviceId: '65647012-92b6-5f99-b688-77555f48778a',
    key: 'visitDate',
    label: 'Preferred visit date',
    type: 'date',
    required: false,
    sortOrder: 1,
    options: [],
    config: {},
    dateRole: 'start',
    sensitive: false,
  },
  {
    id: 'aad7c0ed-0274-5d3d-837c-5c8394ad0bf3',
    serviceId: '9b8a5a40-bbb9-5595-a283-ce6d15d91841',
    key: 'quantity',
    label: 'Estimated quantity and unit',
    type: 'short_text',
    required: true,
    sortOrder: 0,
    options: [],
    config: {
      minLength: 2,
      maxLength: 200,
    },
    dateRole: null,
    sensitive: false,
  },
  {
    id: '19b49fb0-7a46-5d5f-88e1-16af97ed38e9',
    serviceId: '9b8a5a40-bbb9-5595-a283-ce6d15d91841',
    key: 'access',
    label: 'Pickup access instructions',
    type: 'long_text',
    required: true,
    sortOrder: 1,
    options: [],
    config: {
      minLength: 5,
      maxLength: 1000,
    },
    dateRole: null,
    sensitive: true,
  },
  {
    id: 'bfcfb944-3c7d-511f-90e5-9e50d55774dc',
    serviceId: '9b8a5a40-bbb9-5595-a283-ce6d15d91841',
    key: 'pickupDate',
    label: 'Preferred pickup date',
    type: 'date',
    required: true,
    sortOrder: 2,
    options: [],
    config: {},
    dateRole: 'start',
    sensitive: false,
  },
  {
    id: '1de330fa-6ed7-510e-b0e4-1897e04f32eb',
    serviceId: 'cb7841ca-95b3-51e7-8cef-4159b9632b48',
    key: 'operator',
    label: 'Operator required?',
    type: 'yes_no',
    required: false,
    sortOrder: 1,
    options: [],
    config: {},
    dateRole: null,
    sensitive: false,
  },
];

/** Roots renamed from their first-seed names. Their old name is rewritten wherever it is stored. */
export const RENAMED_ROOTS: Array<{ id: string; from: string; to: string }> = [
  {
    id: '0571b359-ca19-53fd-bcc0-c9ffa95ee362',
    from: 'Hire',
    to: 'Hiring',
  },
  {
    id: '65647012-92b6-5f99-b688-77555f48778a',
    from: 'Facility management',
    to: 'Facility Management',
  },
  {
    id: '9b8a5a40-bbb9-5595-a283-ce6d15d91841',
    from: 'Waste management',
    to: 'Waste Management',
  },
];

/** Retired, children before parents. Deactivated; deleted only when childless and unreferenced by a request. */
export const RETIRED_SERVICES: Array<{ id: string; name: string }> = [
  {
    id: 'cab2dd5a-cef5-578f-8882-9dc022c68659',
    name: 'Cement and blocks',
  },
  {
    id: 'b323464d-b1a8-5cd6-a3c1-c182fd05e8a7',
    name: 'Iron rods and steel',
  },
  {
    id: 'c9579314-e704-5a49-ac61-e639c9450bb4',
    name: 'Sand and granite',
  },
  {
    id: '5b0f6967-1277-5aa4-9faa-38a73214c18e',
    name: 'Tiles and flooring',
  },
  {
    id: 'c70f0e69-0a9f-5d2a-8653-f34a428f400c',
    name: 'Paint and finishes',
  },
  {
    id: '65845a2e-6d4c-5af3-a442-0780e963aa9f',
    name: 'Plumbing and electrical fittings',
  },
  {
    id: '4b13b0c4-8160-5d4a-a16c-dc17db9dfb6e',
    name: 'Roofing materials',
  },
  {
    id: 'f78a1379-4a82-539d-b7a5-7ded491b386e',
    name: 'Wood and boards',
  },
  {
    id: 'ff624c28-1320-5a71-a3ee-f8912e79964a',
    name: 'Renovation',
  },
  {
    id: '3dc35f73-9811-5666-a95e-2e44c3542c52',
    name: 'Routine maintenance',
  },
  {
    id: 'e25f1610-1ec1-5caa-9fc0-f4384786d0db',
    name: 'Procurement',
  },
];

/** The Hiring trade questions: trades are sub-services now, so these stop being asked. The rows stay for old answer snapshots. */
export const DEACTIVATED_QUESTION_IDS: string[] = [
  '6fa3699e-c7df-5856-ab6a-64a5fb29f353',
  '9c22789a-014b-52a8-b860-f638fc088c3f',
  'ea1c7e71-d5b1-5f07-b69b-f41ede5b5ff8',
];

/** Construction groups that used to be skills themselves. A provider holding one now holds all its leaves. */
export const EXPANDED_GROUPS = {
  rootId: 'e7d44a80-1de0-57a0-ba41-2bf724259b60',
  groupIds: [
    '8c136806-c53c-51c7-b585-031700b7b99f',
    'f9cc068d-891c-5ba4-a6b6-775610a458b3',
    '327785d5-940f-5cbe-ad84-90a883adef38',
    '29817a60-299d-59e8-b7b3-545cc6aae38a',
  ],
};

export const MIN_CATALOG_DEPTH = 3;
