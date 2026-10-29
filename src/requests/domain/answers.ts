import type { DateRole, QuestionType } from '@prisma/client';

export type AnswerValue = string | number | string[];

export type AnswerSnapshot = {
  questionId: string;
  serviceId: string;
  serviceName: string;
  key: string;
  label: string;
  type: QuestionType;
  value: AnswerValue;
  display: string;
  optionIds?: string[];
  sensitive: boolean;
  dateRole?: DateRole;
  matchesSkill: boolean;
};

export function answerSnapshots(value: unknown): AnswerSnapshot[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is AnswerSnapshot =>
          item !== null &&
          typeof item === 'object' &&
          typeof (item as AnswerSnapshot).questionId === 'string' &&
          typeof (item as AnswerSnapshot).key === 'string',
      )
    : [];
}

export function snapshotSkill(
  answers: readonly AnswerSnapshot[],
): AnswerSnapshot | undefined {
  return answers.find(({ matchesSkill }) => matchesSkill);
}

/** Answers the customer gave back to the form, keyed by question id, for re-validating an unchanged answer set. */
export function answersByQuestion(
  answers: readonly AnswerSnapshot[],
): Record<string, AnswerValue> {
  return Object.fromEntries(
    answers.map((answer) => [
      answer.questionId,
      answer.optionIds
        ? answer.type === 'multiple_choice'
          ? answer.optionIds
          : answer.optionIds[0]
        : answer.value,
    ]),
  );
}
