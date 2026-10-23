import { AppError } from '../../platform/errors/app-error';
import {
  hireTradeGroups,
  intakeFields,
  serviceLines,
  type IntakeField,
  type ServiceLine,
} from '../../platform/catalog/service-lines';

export type IntakeValidationInput = {
  title?: unknown;
  service?: unknown;
  preferredProviderId?: unknown;
  providerId?: unknown;
  cityId?: unknown;
  districtId?: unknown;
  address?: unknown;
  phone?: unknown;
  contactMethod?: unknown;
  description?: unknown;
  budget?: unknown;
  startDate?: unknown;
  details?: unknown;
  attachments?: unknown;
};

export type IntakeLocation = {
  id: string;
  kind: string;
  parentId: string | null;
  active: boolean;
};

export type ValidatedIntake = {
  title: string;
  service: ServiceLine;
  cityId: string;
  districtId: string;
  address: string;
  phone: string;
  contactMethod: 'email' | 'phone' | 'both';
  description: string;
  budget: number;
  startDate: string | null;
  details: Record<string, string | number>;
  attachmentIds: string[];
  effectiveStartDate: string | null;
  effectiveEndDate: string | null;
  contactInBrief: boolean;
};

const fail = (message: string): never => {
  throw new AppError(422, 'VALIDATION_ERROR', message);
};

const text = (value: unknown): value is string => typeof value === 'string';
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

/** Validate intake in the same first-failure order as Spec 04 §6.2. */
export function validateIntake(
  input: IntakeValidationInput,
  catalogue: Partial<Record<ServiceLine, readonly IntakeField[]>> = intakeFields,
  locations: readonly IntakeLocation[] = [],
  now = new Date(),
): ValidatedIntake {
  const title = text(input.title) ? input.title.trim() : '';
  const description = text(input.description) ? input.description.trim() : '';
  if (title.length < 3 || title.length > 120 || description.length < 20 || description.length > 5000)
    fail('Add a title and a project brief of at least 20 characters.');

  if (typeof input.service !== 'string' || !serviceLines.includes(input.service as ServiceLine))
    fail('Choose a valid service.');
  const service = input.service as ServiceLine;

  const detailsInput = input.details !== null && typeof input.details === 'object' && !Array.isArray(input.details)
    ? input.details as Record<string, unknown>
    : {};
  if (input.preferredProviderId !== undefined || input.providerId !== undefined || 'provider' in detailsInput)
    fail('XPro assigns a verified provider for you. Remove the provider preference.');

  const city = locations.find((location) => location.id === input.cityId && location.kind === 'city' && location.active && location.parentId === null);
  const district = locations.find((location) => location.id === input.districtId && location.kind === 'district' && location.active);
  if (!city || !district || district.parentId !== city.id)
    fail('Choose your city and district from the list.');

  if (!text(input.address) || input.address.trim().length < 5 || input.address.trim().length > 300 || !text(input.phone) || !input.phone.trim())
    fail('Complete your contact and site details.');
  const phone = normalizeNigerianPhone(input.phone);
  if (!phone) fail('Enter a valid Nigerian phone number.');

  const contactMethod = input.contactMethod === undefined ? 'phone' : input.contactMethod;
  if (contactMethod !== 'email' && contactMethod !== 'phone' && contactMethod !== 'both')
    fail('Choose how XPro should contact you: email, phone or both.');
  if (!Number.isSafeInteger(input.budget) || Number(input.budget) < 0)
    fail('Budget must be zero or a positive amount.');

  const fields = catalogue[service] ?? intakeFields[service];
  const details: Record<string, string | number> = {};
  for (const field of fields) {
    const value = detailsInput[field.key];
    if (field.required && (value === undefined || value === null || value === ''))
      fail(`Complete ${field.label.toLowerCase()}.`);
  }
  for (const field of fields) {
    const value = detailsInput[field.key];
    if (value === undefined || value === null || value === '') continue;
    if (field.type === 'select' && (!text(value) || !field.options?.includes(value)))
      fail(`Choose a valid ${field.label.toLowerCase()}.`);
  }
  for (const field of fields) {
    const value = detailsInput[field.key];
    if (value === undefined || value === null || value === '' || field.type !== 'number') continue;
    const number = typeof value === 'number' ? value : Number(value);
    const isHireQuantity = service === 'Hire' && field.key === 'quantity';
    if (!Number.isFinite(number) || (field.integer && !Number.isInteger(number))
      || (!isHireQuantity && field.min !== undefined && (field.exclusiveMinimum ? number <= field.min : number < field.min))
      || (field.max !== undefined && !isHireQuantity && number > field.max)) {
      if (isHireQuantity) continue;
      fail(`${field.label} must be positive.`);
    }
    details[field.key] = number;
  }
  for (const field of fields) {
    const value = detailsInput[field.key];
    if (value === undefined || value === null || value === '') continue;
    if (field.type === 'text') {
      if (!text(value)) fail(`Complete ${field.label.toLowerCase()}.`);
      if ((field.minLength !== undefined && value.trim().length < field.minLength) || (field.maxLength !== undefined && value.trim().length > field.maxLength))
        fail(`Complete ${field.label.toLowerCase()}.`);
      details[field.key] = value.trim();
    } else if (field.type === 'select') {
      details[field.key] = value as string;
    }
  }
  if (service === 'Hire' && !text(input.startDate)) fail('Add the hire start date.');
  for (const field of fields) {
    const value = detailsInput[field.key];
    if (field.type !== 'date' || value === undefined || value === null || value === '') continue;
    if (!text(value) || !isIsoDate(value)) fail(`${field.label} must be a valid date.`);
    details[field.key] = value;
  }
  if (input.startDate !== undefined && input.startDate !== null && input.startDate !== ''
    && (!text(input.startDate) || !isIsoDate(input.startDate)))
    fail('Start date must be a valid date.');
  const inputDates = [input.startDate, ...fields.filter(({ type }) => type === 'date').map(({ key }) => detailsInput[key])]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (inputDates.some((date) => !isIsoDate(date))) {
    const invalidField = fields.find(({ type, key }) => type === 'date' && typeof detailsInput[key] === 'string' && !isIsoDate(detailsInput[key] as string));
    fail(`${invalidField?.label ?? 'Date'} must be a valid date.`);
  }
  const today = watDate(now);
  const maxDate = addDays(today, 365);
  if (inputDates.some((date) => date < today)) fail('Choose a date from today onwards.');
  if (inputDates.some((date) => date > maxDate)) fail('Choose a date within the next 12 months.');

  if (service === 'Hire' && String(details.endDate) < String(input.startDate))
    fail('Hire end date cannot be before the start date.');
  if (service === 'Hire') {
    const group = hireTradeGroups[details.hireType as keyof typeof hireTradeGroups];
    if (!group?.includes(details.trade as never))
      fail('Choose a trade or equipment type that matches the hire category.');
  }
  if (service === 'Hire') {
    const quantity = details.quantity;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > 10)
      fail('Quantity must be a whole number from 1 to 10.');
  }

  if (input.attachments !== undefined && !Array.isArray(input.attachments))
    fail("One of your files didn't finish uploading. Remove it and try again.");
  const attachmentIds = Array.isArray(input.attachments)
    ? input.attachments.map((item) => typeof item === 'string' ? item : item && typeof item === 'object' && 'id' in item ? String((item as { id: unknown }).id) : '')
    : [];
  if (Array.isArray(input.attachments) && (attachmentIds.some((id) => !id) || new Set(attachmentIds).size !== attachmentIds.length))
    fail("One of your files didn't finish uploading. Remove it and try again.");
  if (attachmentIds.length > 20)
    fail('A request can hold up to 20 files. Remove one before adding more.');

  const effectiveStartDate = service === 'Waste management'
    ? stringDetail(details, 'pickupDate')
    : service === 'Procurement'
      ? stringDetail(details, 'deliveryDate')
      : service === 'Facility management'
        ? stringDetail(details, 'visitDate') ?? optionalIsoDate(input.startDate)
        : optionalIsoDate(input.startDate);
  const effectiveEndDate = service === 'Hire' ? stringDetail(details, 'endDate') : null;
  return {
    title, service, cityId: city.id, districtId: district.id,
    address: input.address.trim(), phone, contactMethod,
    description, budget: input.budget as number,
    startDate: optionalIsoDate(input.startDate), details, attachmentIds,
    effectiveStartDate, effectiveEndDate,
    contactInBrief: /(?:\+?\d[\d\s().-]{7,}\d)|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(`${title}\n${description}`),
  };
}

export function normalizeNigerianPhone(value: string): string | null {
  const compact = value.replace(/[\s().-]/g, '');
  if (/^0[789][01]\d{8}$/.test(compact)) return `+234${compact.slice(1)}`;
  if (/^234[789][01]\d{8}$/.test(compact)) return `+${compact}`;
  if (/^\+234[789][01]\d{8}$/.test(compact)) return compact;
  return null;
}

function isIsoDate(value: string): boolean {
  if (!datePattern.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function watDate(value: Date): string {
  return new Date(value.getTime() + 60 * 60 * 1000).toISOString().slice(0, 10);
}

function addDays(date: string, count: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + count);
  return parsed.toISOString().slice(0, 10);
}

function optionalIsoDate(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function stringDetail(details: Record<string, string | number>, key: string): string | null {
  return typeof details[key] === 'string' ? details[key] as string : null;
}
