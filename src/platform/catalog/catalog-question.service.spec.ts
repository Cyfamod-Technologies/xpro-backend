import { ConflictException } from '@nestjs/common';
import { fakeCatalog } from './catalog-fakes.testkit';
import { slugKey, uniqueKey } from './catalog.rules';

const uid = 'staff-1';

const lastCreated = (tx: ReturnType<typeof fakeCatalog>['tx']) =>
  tx.serviceQuestion.create.mock.calls.at(-1)![0].data;

describe('CatalogQuestionService', () => {
  describe('keys', () => {
    it('builds a camelCase slug and suffixes clashes', () => {
      expect(slugKey('Operator required?')).toBe('operatorRequired');
      expect(slugKey('3rd floor access')).toBe('q3rdFloorAccess');
      expect(slugKey('???')).toBe('question');
      expect(uniqueKey('Quantity', new Set(['quantity', 'quantity2']))).toBe(
        'quantity3',
      );
    });

    it('generates a key unique along the path, including descendants and ancestors', async () => {
      const { questionService, tx } = fakeCatalog();
      await questionService.create(uid, 'svc:Hiring', {
        label: 'Trade',
        type: 'short_text',
      });
      expect(lastCreated(tx)).toMatchObject({ key: 'trade2', sortOrder: 2 });
      await questionService.create(uid, 'svc:Hiring/Heavy equipment', {
        label: 'Quantity',
        type: 'number',
      });
      expect(lastCreated(tx)).toMatchObject({ key: 'quantity2' });
      await questionService.create(uid, 'svc:Hiring/Professional', {
        label: 'Operator required?',
        type: 'yes_no',
      });
      expect(lastCreated(tx)).toMatchObject({ key: 'operatorRequired' });
    });
  });

  describe('create validation', () => {
    it('stores the normalised options, config and flags', async () => {
      const { questionService, tx, audit } = fakeCatalog();
      const created = await questionService.create(uid, 'svc:Design', {
        label: '  Style ',
        helpText: '',
        type: 'multiple_choice',
        required: true,
        options: [{ label: 'Modern' }, { label: 'Classic', active: false }],
        config: { min: 3 },
        sensitive: true,
      });
      const data = tx.serviceQuestion.create.mock.calls[0][0].data;
      expect(data).toMatchObject({
        key: 'style',
        label: 'Style',
        helpText: null,
        required: true,
        config: {},
        sensitive: true,
        matchesSkill: false,
        dateRole: null,
      });
      const options = data.options as Array<{
        id: string;
        label: string;
        active: boolean;
      }>;
      expect(options.map(({ label, active }) => [label, active])).toEqual([
        ['Modern', true],
        ['Classic', false],
      ]);
      expect(options[0].id).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.key).toBe('style');
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'catalog.question.created' }),
      );
    });

    it.each([
      [{ type: 'single_choice' as const }, 'Add at least one active option.'],
      [
        {
          type: 'single_choice' as const,
          options: [{ label: 'A' }, { label: 'a' }],
        },
        'The option "a" appears more than once.',
      ],
      [
        { type: 'short_text' as const, dateRole: 'start' as const },
        'Only date questions can be a start or end date.',
      ],
      [
        { type: 'number' as const, config: { min: 5, max: 1 } },
        'The minimum cannot be above the maximum.',
      ],
      [
        { type: 'short_text' as const, config: { minLength: 9, maxLength: 3 } },
        'The minimum length cannot be above the maximum length.',
      ],
    ])('rejects %j', async (extra, message) => {
      const { questionService } = fakeCatalog();
      await expect(
        questionService.create(uid, 'svc:Design', { label: 'Q', ...extra }),
      ).rejects.toThrow(message);
    });
  });

  describe('option ids are unique within a root', () => {
    const taken = 'svc:Hiring/Heavy equipment:trade:Excavator';

    it('rejects a new question that reuses an option id from the same root', async () => {
      const { questionService, tx } = fakeCatalog();
      await expect(
        questionService.create(uid, 'svc:Hiring/Professional', {
          label: 'Specialism',
          type: 'single_choice',
          options: [{ id: taken, label: 'Excavation' }],
        }),
      ).rejects.toThrow('Each option needs its own id.');
      expect(tx.serviceQuestion.create).not.toHaveBeenCalled();
    });

    it('allows the same id under another root', async () => {
      const { questionService } = fakeCatalog();
      await expect(
        questionService.create(uid, 'svc:Design', {
          label: 'Specialism',
          type: 'single_choice',
          options: [{ id: taken, label: 'Excavation' }],
        }),
      ).resolves.toBeDefined();
    });

    it('rejects an update that gives an option another question’s id, but keeps the question’s own', async () => {
      const { questionService, catalog } = fakeCatalog();
      const options = catalog.byId.get('svc:Hiring/Professional')!.questions[0]
        .options;
      await expect(
        questionService.update(uid, 'q:svc:Hiring/Professional:trade', {
          version: 1,
          options: [...options, { id: taken, label: 'Excavation' }],
        }),
      ).rejects.toThrow('Each option needs its own id.');
      await expect(
        questionService.update(uid, 'q:svc:Hiring/Professional:trade', {
          version: 1,
          options: [...options, { label: 'Estimator' }],
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('one skill, start and end per path', () => {
    it('never creates a question that matches the provider skill', async () => {
      const { questionService, tx } = fakeCatalog();
      await questionService.create(uid, 'svc:Design', {
        label: 'Another',
        type: 'single_choice',
        options: [{ label: 'A' }],
        matchesSkill: true,
      } as never);
      expect(tx.serviceQuestion.create.mock.calls[0][0].data).toMatchObject({
        matchesSkill: false,
      });
    });

    it('rejects a second start or end date on the path but allows the other role', async () => {
      const { questionService } = fakeCatalog();
      await expect(
        questionService.create(uid, 'svc:Hiring/Professional', {
          label: 'Finish',
          type: 'date',
          dateRole: 'end',
        }),
      ).rejects.toThrow(
        'Only one question on a service path can be the end date.',
      );
      await expect(
        questionService.create(uid, 'svc:Hiring/Professional', {
          label: 'Begin',
          type: 'date',
          dateRole: 'start',
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('update', () => {
    const tradeId = 'q:svc:Hiring/Professional:trade';

    it('returns 409 when the version is stale', async () => {
      const { questionService } = fakeCatalog();
      await expect(
        questionService.update(uid, tradeId, { version: 3, label: 'X' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('keeps the key, bumps the version and replaces config wholesale', async () => {
      const { questionService, tx } = fakeCatalog();
      const result = await questionService.update(
        uid,
        'q:svc:Hiring:quantity',
        {
          version: 1,
          label: 'How many',
          config: { max: 20 },
          helpText: '',
        },
      );
      const data = tx.serviceQuestion.update.mock.calls[0][0].data;
      expect(data).toMatchObject({
        label: 'How many',
        helpText: null,
        config: { max: 20 },
        version: { increment: 1 },
      });
      expect(result.key).toBe('quantity');
      expect(result.version).toBe(2);
    });

    it('skips the write when nothing changed', async () => {
      const { questionService, tx } = fakeCatalog();
      await questionService.update(uid, 'q:svc:Hiring:quantity', {
        version: 1,
        label: 'Quantity',
      });
      expect(tx.serviceQuestion.update).not.toHaveBeenCalled();
    });

    it('refuses a type change that leaves a date role or skill flag behind', async () => {
      const { questionService } = fakeCatalog();
      await expect(
        questionService.update(uid, 'q:svc:Hiring:endDate', {
          version: 1,
          type: 'short_text',
        }),
      ).rejects.toThrow('Only date questions can be a start or end date.');
      await expect(
        questionService.update(uid, tradeId, {
          version: 1,
          type: 'multiple_choice',
        }),
      ).rejects.toThrow(
        'Only a single-choice question can match the provider skill.',
      );
    });

    it('renames a skill option in provider profiles', async () => {
      const { questionService, tx, catalog } = fakeCatalog({
        profiles: [
          {
            id: 'p1',
            services: ['Hiring'],
            skills: { Hiring: ['Architect', 'Mason'] },
            pendingChanges: null,
          },
        ],
      });
      const question = catalog.byId.get('svc:Hiring/Professional')!
        .questions[0];
      const options = question.options.map((option) =>
        option.label === 'Architect'
          ? { ...option, label: 'Architect (registered)' }
          : option,
      );
      await questionService.update(uid, tradeId, { version: 1, options });
      expect(tx.providerProfile.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: {
          services: ['Hiring'],
          skills: { Hiring: ['Architect (registered)', 'Mason'] },
        },
      });
    });

    it('does not touch providers when a non-skill question is renamed', async () => {
      const { questionService, tx } = fakeCatalog({
        profiles: [
          { id: 'p1', services: ['Hiring'], skills: {}, pendingChanges: null },
        ],
      });
      await questionService.update(uid, 'q:svc:Hiring:quantity', {
        version: 1,
        label: 'Count',
      });
      expect(tx.providerProfile.update).not.toHaveBeenCalled();
    });
  });

  describe('remove and reorder', () => {
    it('always deletes a question', async () => {
      const { questionService, tx } = fakeCatalog({ requests: 50 });
      await expect(
        questionService.remove(uid, 'q:svc:Hiring:quantity'),
      ).resolves.toEqual({ id: 'q:svc:Hiring:quantity' });
      expect(tx.serviceQuestion.delete).toHaveBeenCalledWith({
        where: { id: 'q:svc:Hiring:quantity' },
      });
      await expect(questionService.remove(uid, 'nope')).rejects.toThrow(
        'Question not found.',
      );
    });

    it('reorders among the service questions only', async () => {
      const { questionService, tx } = fakeCatalog();
      await questionService.reorder(uid, 'svc:Hiring', {
        ids: ['q:svc:Hiring:endDate', 'q:svc:Hiring:quantity'],
      });
      expect(tx.serviceQuestion.update).toHaveBeenCalledTimes(2);
      await expect(
        questionService.reorder(uid, 'svc:Hiring', {
          ids: ['q:svc:Hiring:endDate'],
        }),
      ).rejects.toThrow('exactly once');
    });
  });
});
