import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { renameInProfiles } from './catalog-rename';
import {
  assertOptionIdsFree,
  assertSameSet,
  assertSingleTraits,
  normalizeQuestion,
  notFound,
  pathScope,
  uniqueKey,
  type QuestionDraft,
} from './catalog.rules';
import { CatalogService, versionConflict } from './catalog.service';
import { pathTo, toQuestion, withCatalogLock } from './catalog.tree';
import type { CatalogIndex, CatalogQuestion } from './catalog.types';
import type {
  CreateQuestionDto,
  ReorderQuestionsDto,
  UpdateQuestionDto,
} from './dto/catalog.dto';

function findQuestion(catalog: CatalogIndex, id: string) {
  for (const node of catalog.byId.values()) {
    const question = node.questions.find((item) => item.id === id);
    if (question) return { node, question };
  }
  throw notFound('Question not found.');
}

const json = (value: unknown) => value as Prisma.InputJsonValue;

@Injectable()
export class CatalogQuestionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
  ) {}

  async create(userId: string, serviceId: string, dto: CreateQuestionDto) {
    const actor = await this.catalog.requireManager(userId);
    const created = await withCatalogLock(this.prisma, async (tx, catalog) => {
      const node = catalog.byId.get(serviceId);
      if (!node) throw notFound('Service not found.');
      const draft = normalizeQuestion({
        label: dto.label,
        helpText: dto.helpText ?? null,
        type: dto.type,
        required: dto.required ?? false,
        active: true,
        options: dto.options ?? [],
        config: { ...dto.config },
        dateRole: dto.dateRole ?? null,
        sensitive: dto.sensitive ?? false,
        matchesSkill: false,
      });
      const scope = pathScope(catalog, node);
      assertSingleTraits(scope, draft);
      assertOptionIdsFree(catalog, node, draft.options);
      const row = await tx.serviceQuestion.create({
        data: {
          serviceId,
          key: uniqueKey(draft.label, new Set(scope.map(({ key }) => key))),
          label: draft.label,
          helpText: draft.helpText,
          type: draft.type,
          required: draft.required,
          sortOrder:
            Math.max(-1, ...node.questions.map((q) => q.sortOrder)) + 1,
          active: true,
          options: json(draft.options),
          config: json(draft.config),
          dateRole: draft.dateRole,
          sensitive: draft.sensitive,
          matchesSkill: draft.matchesSkill,
        },
      });
      return toQuestion(row);
    });
    this.catalog.record(actor, 'catalog.question.created', created.id, {
      serviceId,
      key: created.key,
      type: created.type,
    });
    return created;
  }

  async update(userId: string, id: string, dto: UpdateQuestionDto) {
    const actor = await this.catalog.requireManager(userId);
    const result = await withCatalogLock(this.prisma, async (tx, catalog) => {
      const { node, question } = findQuestion(catalog, id);
      if (dto.version !== question.version) throw versionConflict('question');
      const draft = normalizeQuestion({
        label: dto.label ?? question.label,
        helpText: dto.helpText !== undefined ? dto.helpText : question.helpText,
        type: dto.type ?? question.type,
        required: dto.required ?? question.required,
        active: dto.active ?? question.active,
        options: dto.options ?? question.options,
        config: dto.config ? { ...dto.config } : question.config,
        dateRole: dto.dateRole !== undefined ? dto.dateRole : question.dateRole,
        sensitive: dto.sensitive ?? question.sensitive,
        matchesSkill: question.matchesSkill,
      });
      assertSingleTraits(pathScope(catalog, node), { id, ...draft });
      assertOptionIdsFree(
        catalog,
        node,
        draft.options.filter(
          ({ id: optionId }) =>
            !question.options.some((before) => before.id === optionId),
        ),
        id,
      );
      const fields = changedFields(question, draft);
      if (!fields.length) return { question, fields };
      const row = await tx.serviceQuestion.update({
        where: { id },
        data: {
          label: draft.label,
          helpText: draft.helpText,
          type: draft.type,
          required: draft.required,
          active: draft.active,
          options: json(draft.options),
          config: json(draft.config),
          dateRole: draft.dateRole,
          sensitive: draft.sensitive,
          matchesSkill: draft.matchesSkill,
          version: { increment: 1 },
        },
      });
      if (question.matchesSkill && draft.matchesSkill)
        for (const option of draft.options) {
          const before = question.options.find(
            ({ id: oid }) => oid === option.id,
          );
          if (before && before.label !== option.label)
            await renameInProfiles(tx, {
              root: pathTo(catalog, node.id)[0].name,
              from: before.label,
              to: option.label,
            });
        }
      return { question: toQuestion(row), fields };
    });
    if (result.fields.length)
      this.catalog.record(actor, 'catalog.question.updated', id, {
        serviceId: result.question.serviceId,
        fields: result.fields,
      });
    return result.question;
  }

  async remove(userId: string, id: string) {
    const actor = await this.catalog.requireManager(userId);
    const { node, question } = await withCatalogLock(
      this.prisma,
      async (tx, catalog) => {
        const found = findQuestion(catalog, id);
        await tx.serviceQuestion.delete({ where: { id } });
        return found;
      },
    );
    this.catalog.record(actor, 'catalog.question.deleted', id, {
      serviceId: node.id,
      key: question.key,
    });
    return { id };
  }

  async reorder(userId: string, serviceId: string, dto: ReorderQuestionsDto) {
    const actor = await this.catalog.requireManager(userId);
    await withCatalogLock(this.prisma, async (tx, catalog) => {
      const node = catalog.byId.get(serviceId);
      if (!node) throw notFound('Service not found.');
      assertSameSet(
        node.questions.map(({ id }) => id),
        dto.ids,
      );
      for (const [index, id] of dto.ids.entries())
        if (node.questions.find((q) => q.id === id)?.sortOrder !== index)
          await tx.serviceQuestion.update({
            where: { id },
            data: { sortOrder: index },
          });
    });
    this.catalog.record(actor, 'catalog.question.reordered', serviceId, {
      ids: dto.ids,
    });
    return { ids: dto.ids };
  }
}

function changedFields(
  question: CatalogQuestion,
  draft: QuestionDraft,
): string[] {
  const keys = [
    'label',
    'helpText',
    'type',
    'required',
    'active',
    'options',
    'config',
    'dateRole',
    'sensitive',
    'matchesSkill',
  ] as const;
  return keys.filter(
    (key) => JSON.stringify(question[key]) !== JSON.stringify(draft[key]),
  );
}
