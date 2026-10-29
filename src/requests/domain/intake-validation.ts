import type { QuestionType } from '@prisma/client';
import { AppError } from '../../platform/errors/app-error';
import type {
  CatalogOption,
  CatalogQuestion,
  QuestionConfig,
  ResolvedService,
} from '../../platform/catalog/catalog.types';
import type { AnswerSnapshot, AnswerValue } from './answers';

export type IntakeValidationInput = {
  title?: unknown;
  service?: unknown;
  serviceId?: unknown;
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
  answers?: unknown;
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
  service: string;
  serviceId: string;
  serviceRootId: string;
  servicePath: Array<{ id: string; name: string }>;
  skill: string | null;
  cityId: string;
  districtId: string;
  address: string;
  phone: string;
  contactMethod: 'email' | 'phone' | 'both';
  description: string;
  budget: number;
  startDate: string | null;
  details: Record<string, string | number | string[]>;
  answers: AnswerSnapshot[];
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
const TEXT_LIMITS: Partial<Record<QuestionType, number>> = {
  short_text: 500,
  long_text: 5000,
};

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0);

type Normalized = {
  value: AnswerValue;
  display: string;
  optionIds?: string[];
};

/** Validate intake in the same first-failure order as Spec 04 §6.2. */
export function validateIntake(
  input: IntakeValidationInput,
  resolved: ResolvedService | null,
  locations: readonly IntakeLocation[] = [],
  now = new Date(),
): ValidatedIntake {
  const title = text(input.title) ? input.title.trim() : '';
  const description = text(input.description) ? input.description.trim() : '';
  if (
    title.length < 3 ||
    title.length > 120 ||
    description.length < 20 ||
    description.length > 5000
  )
    fail('Add a title and a project brief of at least 20 characters.');

  if (!resolved) return fail('Choose a valid service.');
  const { path, questions } = resolved;
  const root = path[0];
  const leaf = path[path.length - 1];

  const detailsInput =
    input.details !== null &&
    typeof input.details === 'object' &&
    !Array.isArray(input.details)
      ? (input.details as Record<string, unknown>)
      : {};
  if (
    input.preferredProviderId !== undefined ||
    input.providerId !== undefined ||
    'provider' in detailsInput
  )
    fail(
      'XPro assigns a verified provider for you. Remove the provider preference.',
    );

  const city = locations.find(
    (location) =>
      location.id === input.cityId &&
      location.kind === 'city' &&
      location.active &&
      location.parentId === null,
  );
  const district = locations.find(
    (location) =>
      location.id === input.districtId &&
      location.kind === 'district' &&
      location.active,
  );
  if (!city || !district || district.parentId !== city.id)
    return fail('Choose your city and district from the list.');

  const address = text(input.address) ? input.address.trim() : '';
  const phoneInput = text(input.phone) ? input.phone.trim() : '';
  if (address.length < 5 || address.length > 300 || !phoneInput)
    fail('Complete your contact and site details.');
  const phone = normalizeNigerianPhone(phoneInput);
  if (!phone) return fail('Enter a valid Nigerian phone number.');

  const contactMethod =
    input.contactMethod === undefined ? 'phone' : input.contactMethod;
  if (
    contactMethod !== 'email' &&
    contactMethod !== 'phone' &&
    contactMethod !== 'both'
  )
    return fail('Choose how XPro should contact you: email, phone or both.');
  if (
    typeof input.budget !== 'number' ||
    !Number.isSafeInteger(input.budget) ||
    input.budget < 0
  )
    return fail('Budget must be zero or a positive amount.');

  const given =
    input.answers !== null &&
    typeof input.answers === 'object' &&
    !Array.isArray(input.answers)
      ? (input.answers as Record<string, unknown>)
      : null;
  const valueOf = (question: CatalogQuestion): unknown =>
    given ? given[question.id] : detailsInput[question.key];
  const normalized = new Map<string, Normalized>();

  for (const question of questions)
    if (question.required && isEmpty(valueOf(question)))
      fail(`Complete ${question.label.toLowerCase()}.`);
  for (const question of questions) {
    const value = valueOf(question);
    if (isEmpty(value)) continue;
    const invalid = () =>
      fail(`Choose a valid ${question.label.toLowerCase()}.`);
    if (question.type === 'yes_no') {
      if (value !== 'Yes' && value !== 'No') invalid();
      normalized.set(question.id, {
        value: value as string,
        display: value as string,
      });
    } else if (question.type === 'single_choice') {
      const option = text(value) ? findOption(question, value) : undefined;
      if (!option) return invalid();
      normalized.set(question.id, {
        value: option.label,
        display: option.label,
        optionIds: [option.id],
      });
    } else if (question.type === 'multiple_choice') {
      if (!Array.isArray(value)) return invalid();
      const picked: CatalogOption[] = [];
      for (const item of value) {
        const option = text(item) ? findOption(question, item) : undefined;
        if (!option || picked.some(({ id }) => id === option.id))
          return invalid();
        picked.push(option);
      }
      const labels = picked.map(({ label }) => label);
      normalized.set(question.id, {
        value: labels,
        display: labels.join(', '),
        optionIds: picked.map(({ id }) => id),
      });
    }
  }
  for (const question of questions) {
    const value = valueOf(question);
    if (isEmpty(value) || question.type !== 'number') continue;
    const number =
      typeof value === 'number'
        ? value
        : text(value) && value.trim()
          ? Number(value)
          : Number.NaN;
    const { config } = question;
    if (
      !Number.isFinite(number) ||
      (config.integer && !Number.isInteger(number)) ||
      (config.min !== undefined &&
        (config.exclusiveMinimum
          ? number <= config.min
          : number < config.min)) ||
      (config.max !== undefined && number > config.max)
    )
      fail(numberMessage(question.label, config));
    normalized.set(question.id, { value: number, display: String(number) });
  }
  for (const question of questions) {
    const value = valueOf(question);
    if (
      isEmpty(value) ||
      (question.type !== 'short_text' && question.type !== 'long_text')
    )
      continue;
    const textValue = text(value)
      ? value.trim()
      : fail(`Complete ${question.label.toLowerCase()}.`);
    const { minLength, maxLength } = question.config;
    if (
      (minLength !== undefined && textValue.length < minLength) ||
      textValue.length > (maxLength ?? TEXT_LIMITS[question.type] ?? 5000)
    )
      fail(`Complete ${question.label.toLowerCase()}.`);
    normalized.set(question.id, { value: textValue, display: textValue });
  }
  for (const question of questions) {
    const value = valueOf(question);
    if (question.type !== 'date' || isEmpty(value)) continue;
    if (!text(value) || !isIsoDate(value))
      return fail(`${question.label} must be a valid date.`);
    normalized.set(question.id, { value, display: displayDate(value) });
  }

  const dateOf = (role: 'start' | 'end'): string | null => {
    for (const question of questions) {
      if (question.dateRole !== role) continue;
      const answer = normalized.get(question.id);
      if (answer && typeof answer.value === 'string') return answer.value;
    }
    return null;
  };
  const effectiveStartDate =
    dateOf('start') ?? optionalIsoDate(input.startDate);
  const effectiveEndDate = dateOf('end');
  const hire = root.name === 'Hire';
  if (
    path.some(({ requiresStartDate }) => requiresStartDate) &&
    !effectiveStartDate
  )
    fail(hire ? 'Add the hire start date.' : 'Add the start date.');
  if (
    input.startDate !== undefined &&
    input.startDate !== null &&
    input.startDate !== '' &&
    (!text(input.startDate) || !isIsoDate(input.startDate))
  )
    fail('Start date must be a valid date.');
  const inputDates = [
    input.startDate,
    ...questions
      .filter(({ type }) => type === 'date')
      .map(({ id }) => normalized.get(id)?.value),
  ].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  const today = watDate(now);
  const maxDate = addDays(today, 365);
  if (inputDates.some((date) => date < today))
    fail('Choose a date from today onwards.');
  if (inputDates.some((date) => date > maxDate))
    fail('Choose a date within the next 12 months.');

  if (
    effectiveStartDate &&
    effectiveEndDate &&
    effectiveEndDate < effectiveStartDate
  )
    fail(
      hire
        ? 'Hire end date cannot be before the start date.'
        : 'End date cannot be before the start date.',
    );

  if (input.attachments !== undefined && !Array.isArray(input.attachments))
    fail("One of your files didn't finish uploading. Remove it and try again.");
  const attachmentIds = Array.isArray(input.attachments)
    ? input.attachments.map((item) =>
        typeof item === 'string'
          ? item
          : item && typeof item === 'object' && 'id' in item
            ? String((item as { id: unknown }).id)
            : '',
      )
    : [];
  if (
    Array.isArray(input.attachments) &&
    (attachmentIds.some((id) => !id) ||
      new Set(attachmentIds).size !== attachmentIds.length)
  )
    fail("One of your files didn't finish uploading. Remove it and try again.");
  if (attachmentIds.length > 20)
    fail('A request can hold up to 20 files. Remove one before adding more.');

  const serviceNames = new Map(path.map(({ id, name }) => [id, name]));
  const details: Record<string, string | number | string[]> = {};
  const answers: AnswerSnapshot[] = [];
  for (const question of questions) {
    const answer = normalized.get(question.id);
    if (!answer) continue;
    details[question.key] = answer.value;
    answers.push({
      questionId: question.id,
      serviceId: question.serviceId,
      serviceName: serviceNames.get(question.serviceId) ?? '',
      key: question.key,
      label: question.label,
      type: question.type,
      value: answer.value,
      display: answer.display,
      ...(answer.optionIds ? { optionIds: answer.optionIds } : {}),
      sensitive: question.sensitive,
      ...(question.dateRole ? { dateRole: question.dateRole } : {}),
      matchesSkill: question.matchesSkill,
    });
  }
  const skillAnswer = answers.find(({ matchesSkill }) => matchesSkill);
  const skill =
    typeof skillAnswer?.value === 'string'
      ? skillAnswer.value
      : leaf.depth >= 1
        ? leaf.name
        : null;

  return {
    title,
    service: root.name,
    serviceId: leaf.id,
    serviceRootId: root.id,
    servicePath: path.map(({ id, name }) => ({ id, name })),
    skill,
    cityId: city.id,
    districtId: district.id,
    address,
    phone,
    contactMethod,
    description,
    budget: input.budget,
    startDate: optionalIsoDate(input.startDate),
    details,
    answers,
    attachmentIds,
    effectiveStartDate,
    effectiveEndDate,
    contactInBrief:
      /(?:\+?\d[\d\s().-]{7,}\d)|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(
        `${title}\n${description}`,
      ),
  };
}

function findOption(
  question: CatalogQuestion,
  value: string,
): CatalogOption | undefined {
  const active = question.options.filter((option) => option.active);
  return (
    active.find(({ id }) => id === value) ??
    active.find(({ label }) => label === value)
  );
}

function numberMessage(label: string, config: QuestionConfig): string {
  const { min, max } = config;
  const ranged = min !== undefined && max !== undefined;
  if (config.integer && ranged)
    return `${label} must be a whole number from ${min} to ${max}.`;
  if (config.integer)
    return `${label} must be a whole number${min !== undefined ? ` of at least ${min}` : ''}.`;
  if (config.exclusiveMinimum && min === 0 && max === undefined)
    return `${label} must be positive.`;
  if (ranged) return `${label} must be a number from ${min} to ${max}.`;
  if (min !== undefined)
    return `${label} must be ${config.exclusiveMinimum ? 'more than' : 'at least'} ${min}.`;
  if (max !== undefined) return `${label} must be at most ${max}.`;
  return `${label} must be a number.`;
}

export function normalizeNigerianPhone(value: string): string | null {
  const compact = value.replace(/[\s().-]/g, '');
  if (/^0[789][01]\d{8}$/.test(compact)) return `+234${compact.slice(1)}`;
  if (/^234[789][01]\d{8}$/.test(compact)) return `+${compact}`;
  if (/^\+234[789][01]\d{8}$/.test(compact)) return compact;
  return null;
}

function displayDate(value: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function isIsoDate(value: string): boolean {
  if (!datePattern.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
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
