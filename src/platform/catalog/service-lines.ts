export const serviceLines = [
  'Design',
  'Construction',
  'Hire',
  'Procurement',
  'Facility management',
  'Waste management',
] as const;

export type ServiceLine = (typeof serviceLines)[number];
export type IntakeField = {
  key: string;
  label: string;
  type: 'text' | 'number' | 'date' | 'select';
  options?: string[];
  required: boolean;
  sensitive: boolean;
  isSkill: boolean;
  min?: number;
  max?: number;
  integer?: boolean;
  exclusiveMinimum?: boolean;
  minLength?: number;
  maxLength?: number;
};

const designTypes = ['Architectural plan', 'Structural plan', 'Interior design'];
const workTypes = [
  'Floor finishing',
  'Wall finishing',
  'Roof and ceiling',
  'Final finishing',
  'Renovation',
];
const wasteTypes = ['Residential', 'Commercial', 'Construction debris'];

export const serviceSkills: Record<ServiceLine, string[]> = {
  Design: designTypes,
  Construction: workTypes,
  Hire: [
    'Architect',
    'Civil/structural engineer',
    'Quantity surveyor',
    'Land surveyor',
    'Builder',
    'Site engineer',
    'Interior designer',
    'Mason',
    'Tiler',
    'Plumber',
    'Electrician',
    'Carpenter',
    'Painter',
    'Welder',
    'Heavy equipment operator',
    'Excavator',
    'Crane',
    'Pay loader',
    'Bulldozer',
    'Backhoe',
    'Tipper truck',
    'Concrete mixer',
  ],
  Procurement: [
    'Cement and blocks',
    'Iron rods and steel',
    'Sand and granite',
    'Tiles and flooring',
    'Paint and finishes',
    'Plumbing and electrical fittings',
    'Roofing materials',
    'Wood and boards',
  ],
  'Facility management': [
    'Routine maintenance',
    'Cleaning and janitorial',
    'Repairs',
    'Generator and HVAC servicing',
    'Pest control',
  ],
  'Waste management': wasteTypes,
};

export const skillFieldKey: Record<ServiceLine, string> = {
  Design: 'designType',
  Construction: 'workType',
  Hire: 'trade',
  Procurement: 'category',
  'Facility management': 'serviceNeeds',
  'Waste management': 'wasteType',
};

export const hireTradeGroups = {
  Professional: [
    'Architect',
    'Civil/structural engineer',
    'Quantity surveyor',
    'Land surveyor',
    'Site engineer',
    'Interior designer',
    'Builder',
  ],
  'Vocational worker': [
    'Mason',
    'Tiler',
    'Plumber',
    'Electrician',
    'Carpenter',
    'Painter',
    'Welder',
    'Heavy equipment operator',
  ],
  'Heavy equipment': [
    'Excavator',
    'Crane',
    'Pay loader',
    'Bulldozer',
    'Backhoe',
    'Tipper truck',
    'Concrete mixer',
  ],
} as const;

const field = (
  key: string,
  label: string,
  options?: string[],
  required = false,
  isSkill = false,
  type: IntakeField['type'] = options ? 'select' : 'text',
  sensitive = false,
  constraints: Pick<
    IntakeField,
    'min' | 'max' | 'integer' | 'exclusiveMinimum' | 'minLength' | 'maxLength'
  > = {},
): IntakeField => ({
  key,
  label,
  type,
  options,
  required,
  sensitive,
  isSkill,
  ...constraints,
});

export const intakeFields: Record<ServiceLine, IntakeField[]> = {
  Design: [
    field('designType', 'Design service', serviceSkills.Design, true, true),
    field('delivery', 'Project delivery', ['Design only', 'Design and build with XPro'], true),
  ],
  Construction: [
    field('workType', 'Work required', serviceSkills.Construction, true, true),
    field('area', 'Approximate area (sqm)', undefined, false, false, 'number', false, {
      min: 0,
      exclusiveMinimum: true,
    }),
  ],
  Hire: [
    field('hireType', 'Hire category', Object.keys(hireTradeGroups), true),
    field('trade', 'Trade or equipment required', serviceSkills.Hire, true, true),
    field('quantity', 'Quantity', undefined, true, false, 'number', false, {
      min: 1,
      max: 10,
      integer: true,
    }),
    field('endDate', 'Hire end date', undefined, true, false, 'date'),
    field('operator', 'Operator required?', ['Yes', 'No', 'Not applicable']),
  ],
  Procurement: [
    field('materials', 'Materials and quantities required', undefined, true, false, 'text', false, {
      minLength: 5,
      maxLength: 2000,
    }),
    field('category', 'Material category', serviceSkills.Procurement, true, true),
    field('brands', 'Preferred brands', undefined, false, false, 'text', false, {
      maxLength: 500,
    }),
    field('deliveryDate', 'Required delivery date', undefined, true, false, 'date'),
  ],
  'Facility management': [
    field('propertyType', 'Property type', ['Residential', 'Commercial', 'Industrial'], true),
    field('serviceNeeds', 'Facility services required', serviceSkills['Facility management'], true, true),
    field('visitDate', 'Preferred visit date', undefined, false, false, 'date'),
  ],
  'Waste management': [
    field('wasteType', 'Waste type', serviceSkills['Waste management'], true, true),
    field('quantity', 'Estimated quantity and unit', undefined, true, false, 'text', false, {
      minLength: 2,
      maxLength: 200,
    }),
    field('access', 'Pickup access instructions', undefined, true, false, 'text', true, {
      minLength: 5,
      maxLength: 1000,
    }),
    field('pickupDate', 'Preferred pickup date', undefined, true, false, 'date'),
  ],
};

export const effectiveDateRules = {
  startDate: 'Required for Hire; optional for all other services.',
  effectiveStartDate: {
    'Waste management': 'pickupDate',
    Procurement: 'deliveryDate',
    'Facility management': 'visitDate when provided, otherwise startDate',
    default: 'startDate',
  },
  effectiveEndDate: { Hire: 'endDate', default: null },
  dateRange: 'Every date is an ISO date in WAT, from today through today + 365 days.',
};

export const serviceCatalogue = serviceLines.map((name) => ({
  service: name,
  name,
  intakeFields: intakeFields[name],
  skillFieldKey: skillFieldKey[name],
  serviceSkills: serviceSkills[name],
  effectiveDateRules,
  ...(name === 'Hire' ? { hireTradeGroups } : {}),
}));
