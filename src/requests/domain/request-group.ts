import { AppError } from '../../platform/errors/app-error';

export const MAX_SERVICES_SETTING = 'request.maxServicesPerSubmission';
export const DEFAULT_MAX_SERVICES = 5;
const TITLE_MAX = 120;
const SEPARATOR = ' — ';

export const DUPLICATE_SERVICE_MESSAGE =
  'Add each service once. Use the quantity field to ask for more than one.';
export const PROJECT_FILES_MESSAGE = 'Add files to the service they belong to.';
export const tooManyServicesMessage = (limit: number) =>
  `You can request up to ${limit} services at a time.`;

export function formatGroupRef(sequence: number | bigint): string {
  return `XPG-${String(sequence).padStart(5, '0')}`;
}

export function parseGroupRef(value: string): number | null {
  const match = /^XPG-(\d{5,})$/.exec(value);
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

export function servicesLimit(
  settings: Readonly<Record<string, unknown>>,
): number {
  const value = settings[MAX_SERVICES_SETTING];
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : DEFAULT_MAX_SERVICES;
}

const validation = (message: string, field: string) =>
  new AppError(422, 'VALIDATION_ERROR', message, { field });

/** 04 §6.2 group checks, before any per-service check: the count first, then repeated services. */
export function checkGroupServices(services: unknown, limit: number): void {
  if (
    !Array.isArray(services) ||
    services.length < 1 ||
    services.length > limit
  )
    throw validation(tooManyServicesMessage(limit), 'services');
  const seen = new Set<string>();
  for (const [index, item] of services.entries()) {
    const serviceId = (item as { serviceId?: unknown } | null)?.serviceId;
    if (typeof serviceId !== 'string' || !serviceId) continue;
    if (seen.has(serviceId))
      throw validation(
        DUPLICATE_SERVICE_MESSAGE,
        `services[${index}].serviceId`,
      );
    seen.add(serviceId);
  }
}

/** MS-8: a bundle has no project-level files, so anything other than an empty list at the top level is refused. */
export function checkNoProjectFiles(attachments: unknown): void {
  const empty =
    attachments === undefined ||
    attachments === null ||
    (Array.isArray(attachments) && attachments.length === 0);
  if (!empty) throw validation(PROJECT_FILES_MESSAGE, 'attachments');
}

/** `{project title} — {leaf name}`, cutting the project part so the whole title stays within 120 characters. */
export function childTitle(projectTitle: string, leafName: string): string {
  const suffix = `${SEPARATOR}${leafName}`;
  const room = Math.max(TITLE_MAX - suffix.length, 0);
  let head = projectTitle;
  if (head.length > room) {
    head = head.slice(0, room);
    if (/[\ud800-\udbff]$/.test(head)) head = head.slice(0, -1);
    head = head.trimEnd();
  }
  return `${head}${suffix}`.slice(0, TITLE_MAX);
}

export type FieldPathContext = {
  index: number;
  title: unknown;
  address: unknown;
  /** The field that carried a provider preference, when one was sent. */
  providerField: string;
  questions: ReadonlyArray<{
    id: string;
    label: string;
    dateRole: string | null;
  }>;
};

const START_DATE_MESSAGES = new Set([
  'Add the hire start date.',
  'Add the start date.',
  'Start date must be a valid date.',
  'Choose a date from today onwards.',
  'Choose a date within the next 12 months.',
]);
const END_BEFORE_START_MESSAGES = new Set([
  'Hire end date cannot be before the start date.',
  'End date cannot be before the start date.',
]);
const ATTACHMENT_MESSAGES = new Set([
  "One of your files didn't finish uploading. Remove it and try again.",
  'A request can hold up to 20 files. Remove one before adding more.',
  'Keep the combined file size under 25 MB.',
]);

const lengthOutside = (value: unknown, min: number, max: number) => {
  const length = typeof value === 'string' ? value.trim().length : 0;
  return length < min || length > max;
};

/**
 * The form field a per-service intake message belongs to. Shared fields keep
 * their plain name; a service's own fields, files and answers carry its index
 * (`services[1].description`, `services[1].attachments`, `services[1].answers.<questionId>`). `null` when
 * the message does not point at one field.
 */
export function intakeFieldPath(
  message: string,
  context: FieldPathContext,
): string | null {
  const own = (field: string) => `services[${context.index}].${field}`;
  if (message === 'Add a title and a project brief of at least 20 characters.')
    return lengthOutside(context.title, 3, 120) ? 'title' : own('description');
  if (message === 'Choose a valid service.') return own('serviceId');
  if (
    message ===
    'XPro assigns a verified provider for you. Remove the provider preference.'
  )
    return context.providerField;
  if (message === 'Choose your location from the list.') return 'locationId';
  if (message === 'Complete your contact and site details.')
    return lengthOutside(context.address, 5, 300) ? 'address' : 'phone';
  if (message === 'Enter a valid Nigerian phone number.') return 'phone';
  if (message === 'Choose how XPro should contact you: email, phone or both.')
    return 'contactMethod';
  if (message === 'Budget must be zero or a positive amount.')
    return own('budget');
  if (START_DATE_MESSAGES.has(message)) return own('startDate');
  if (END_BEFORE_START_MESSAGES.has(message)) {
    const end = context.questions.find(({ dateRole }) => dateRole === 'end');
    return end ? own(`answers.${end.id}`) : own('startDate');
  }
  if (ATTACHMENT_MESSAGES.has(message)) return own('attachments');
  const question = context.questions.find(
    ({ label }) =>
      message === `Complete ${label.toLowerCase()}.` ||
      message === `Choose a valid ${label.toLowerCase()}.` ||
      message.startsWith(`${label} must be`),
  );
  return question ? own(`answers.${question.id}`) : null;
}

/** Adds `details.field` to a 422 that has none, so the form can show the message on the right field. */
export function withFieldPath(error: unknown, field: string | null): unknown {
  if (
    !field ||
    !(error instanceof AppError) ||
    error.getStatus() !== 422 ||
    error.details
  )
    return error;
  return new AppError(422, error.code, error.message, { field });
}
