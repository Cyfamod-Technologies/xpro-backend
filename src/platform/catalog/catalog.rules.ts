import { randomUUID } from 'node:crypto';
import type { DateRole, QuestionType } from '@prisma/client';
import { AppError } from '../errors/app-error';
import { descendants, pathTo } from './catalog.tree';
import type {
  CatalogIndex,
  CatalogNode,
  CatalogOption,
  CatalogQuestion,
  QuestionConfig,
} from './catalog.types';

export const MAX_DEPTH_KEY = 'catalog.maxDepth';
export const DEFAULT_MAX_DEPTH = 2;

export const invalid = (message: string) =>
  new AppError(422, 'VALIDATION_ERROR', message);

export const notFound = (message: string) =>
  new AppError(404, 'NOT_FOUND', message);

const CHOICE_TYPES: QuestionType[] = ['single_choice', 'multiple_choice'];
export const isChoice = (type: QuestionType) => CHOICE_TYPES.includes(type);

/** camelCase slug of a label, e.g. "Operator required?" becomes `operatorRequired`. */
export function slugKey(label: string): string {
  const words = label.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const slug = words
    .map((word, index) =>
      index === 0 ? word : word[0].toUpperCase() + word.slice(1),
    )
    .join('')
    .slice(0, 40);
  if (!slug) return 'question';
  return /^[0-9]/.test(slug) ? `q${slug}` : slug;
}

export function uniqueKey(label: string, taken: ReadonlySet<string>): string {
  const base = slugKey(label);
  let key = base;
  for (let n = 2; taken.has(key); n++) key = `${base}${n}`;
  return key;
}

/** Questions that can sit on one request path with this node: its own, its ancestors' and its descendants'. */
export function pathScope(
  catalog: CatalogIndex,
  node: CatalogNode,
): CatalogQuestion[] {
  return [
    ...pathTo(catalog, node.id).flatMap(({ questions }) => questions),
    ...descendants(node).flatMap(({ questions }) => questions),
  ];
}

export type QuestionTraits = {
  id?: string;
  active: boolean;
  matchesSkill: boolean;
  dateRole: DateRole | null;
};

export function assertSingleTraits(
  scope: readonly CatalogQuestion[],
  question: QuestionTraits,
): void {
  if (!question.active) return;
  const others = scope.filter(({ id, active }) => active && id !== question.id);
  if (question.matchesSkill && others.some(({ matchesSkill }) => matchesSkill))
    throw invalid(
      'Only one question on a service path can match the provider skill.',
    );
  if (
    question.dateRole &&
    others.some(({ dateRole }) => dateRole === question.dateRole)
  )
    throw invalid(
      `Only one question on a service path can be the ${question.dateRole} date.`,
    );
}

export type QuestionDraft = {
  label: string;
  helpText: string | null;
  type: QuestionType;
  required: boolean;
  active: boolean;
  options: CatalogOption[];
  config: QuestionConfig;
  dateRole: DateRole | null;
  sensitive: boolean;
  matchesSkill: boolean;
};

export type OptionInput = { id?: string; label: string; active?: boolean };

export function normalizeOptions(
  options: readonly OptionInput[],
): CatalogOption[] {
  const seenIds = new Set<string>();
  const seenLabels = new Set<string>();
  return options.map((option) => {
    const label = option.label.trim();
    if (!label || label.length > 80)
      throw invalid('Each option needs a label of up to 80 characters.');
    const id = option.id ?? randomUUID();
    if (seenIds.has(id)) throw invalid('Each option needs its own id.');
    if (seenLabels.has(label.toLowerCase()))
      throw invalid(`The option "${label}" appears more than once.`);
    seenIds.add(id);
    seenLabels.add(label.toLowerCase());
    return { id, label, active: option.active !== false };
  });
}

/** Provider skills are stored as option ids per root, so an id must name one option under its root. */
export function assertOptionIdsFree(
  catalog: CatalogIndex,
  node: CatalogNode,
  options: readonly CatalogOption[],
  questionId?: string,
): void {
  const root = pathTo(catalog, node.id)[0];
  const taken = new Set(
    [root, ...descendants(root)]
      .flatMap(({ questions }) => questions)
      .filter(({ id }) => id !== questionId)
      .flatMap((question) => question.options.map(({ id }) => id)),
  );
  if (options.some(({ id }) => taken.has(id)))
    throw invalid('Each option needs its own id.');
}

function normalizeConfig(type: QuestionType, config: QuestionConfig) {
  const result: QuestionConfig = {};
  if (type === 'number') {
    for (const key of ['min', 'max'] as const) {
      const value = config[key];
      if (value === undefined) continue;
      if (!Number.isFinite(value))
        throw invalid('Number limits must be numbers.');
      result[key] = value;
    }
    if (config.integer) result.integer = true;
    if (config.exclusiveMinimum) result.exclusiveMinimum = true;
    if (
      result.min !== undefined &&
      result.max !== undefined &&
      result.min > result.max
    )
      throw invalid('The minimum cannot be above the maximum.');
  } else if (type === 'short_text' || type === 'long_text') {
    for (const key of ['minLength', 'maxLength'] as const) {
      const value = config[key];
      if (value === undefined) continue;
      if (!Number.isInteger(value) || value < 0)
        throw invalid('Text limits must be whole numbers from 0.');
      result[key] = value;
    }
    if (
      result.minLength !== undefined &&
      result.maxLength !== undefined &&
      result.minLength > result.maxLength
    )
      throw invalid('The minimum length cannot be above the maximum length.');
  }
  return result;
}

export function normalizeQuestion(
  draft: Omit<QuestionDraft, 'options'> & { options: readonly OptionInput[] },
): QuestionDraft {
  const label = draft.label.trim();
  if (!label || label.length > 120)
    throw invalid('Add a question label of up to 120 characters.');
  const helpText = draft.helpText?.trim() || null;
  if (helpText && helpText.length > 300)
    throw invalid('Help text can be up to 300 characters.');
  const options = isChoice(draft.type) ? normalizeOptions(draft.options) : [];
  if (isChoice(draft.type) && !options.some(({ active }) => active))
    throw invalid('Add at least one active option.');
  if (draft.dateRole && draft.type !== 'date')
    throw invalid('Only date questions can be a start or end date.');
  if (draft.matchesSkill && draft.type !== 'single_choice')
    throw invalid(
      'Only a single-choice question can match the provider skill.',
    );
  return {
    ...draft,
    label,
    helpText,
    options,
    config: normalizeConfig(draft.type, draft.config),
  };
}

export function deepestLevels(catalog: CatalogIndex): number {
  let deepest = 0;
  for (const node of catalog.byId.values())
    deepest = Math.max(deepest, node.depth + 1);
  return deepest;
}

export function siblingsOf(
  catalog: CatalogIndex,
  parentId: string | null,
): CatalogNode[] {
  return parentId
    ? (catalog.byId.get(parentId)?.children ?? [])
    : catalog.roots;
}

export function assertSameSet(
  current: readonly string[],
  given: readonly string[],
): void {
  if (
    given.length !== current.length ||
    new Set(given).size !== given.length ||
    !given.every((id) => current.includes(id))
  )
    throw invalid('Send every item in the list exactly once.');
}

export function skillLeaf(catalog: CatalogIndex, node: CatalogNode): boolean {
  return (
    node.depth >= 1 &&
    node.children.length === 0 &&
    !pathTo(catalog, node.id).some(({ questions }) =>
      questions.some(({ active, matchesSkill }) => active && matchesSkill),
    )
  );
}
