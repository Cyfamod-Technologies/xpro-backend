import { ConflictException } from '@nestjs/common';
import { fakeCatalog } from './catalog-fakes.testkit';
import { indexOf, makeNode, seededCatalog } from './catalog.testkit';

const user = { id: 'staff-1', sid: 'session-1' };

describe('CatalogService', () => {
  describe('permissions', () => {
    it('requires catalog.manage for every admin read and write', async () => {
      const { service } = fakeCatalog({ permissions: ['request.review'] });
      await expect(service.adminCatalog('u')).rejects.toThrow(
        'Your staff role does not allow this action.',
      );
      await expect(
        service.createService('u', { name: 'Roofing' }),
      ).rejects.toThrow('Your staff role does not allow this action.');
    });
  });

  describe('public tree', () => {
    it('lists only active nodes and options and hides nothing needed by the form', async () => {
      const { service, catalog } = fakeCatalog();
      const hire = catalog.byId.get('svc:Hire')!;
      hire.children[0].active = false;
      hire.children[1].questions[0].options[0].active = false;
      const tree = await service.publicTree();
      const publicHire = tree.find(({ name }) => name === 'Hire')!;
      expect(publicHire.children.map(({ name }) => name)).toEqual([
        'Vocational worker',
        'Heavy equipment',
      ]);
      expect(publicHire.questions.map(({ key }) => key)).toEqual([
        'quantity',
        'endDate',
      ]);
      const trade = publicHire.children[0].questions[0];
      expect(trade.options).toHaveLength(7);
      expect(trade).toMatchObject({
        sensitive: false,
        matchesSkill: true,
        type: 'single_choice',
      });
      expect(Object.keys(trade.options[0])).toEqual(['id', 'label']);
    });
  });

  describe('createService', () => {
    it('rejects a level beyond the depth limit and allows it once raised', async () => {
      const blocked = fakeCatalog();
      await expect(
        blocked.service.createService(user.id, {
          parentId: 'svc:Hire/Professional',
          name: 'Junior',
        }),
      ).rejects.toThrow('Services can be nested up to 2 levels');

      const raised = fakeCatalog({ maxDepth: 3 });
      jest.spyOn(raised.service, 'adminNode').mockResolvedValue({} as never);
      await raised.service.createService(user.id, {
        parentId: 'svc:Hire/Professional',
        name: 'Junior',
      });
      expect(
        raised.tx.catalogService.create.mock.calls[0][0].data,
      ).toMatchObject({
        depth: 2,
        name: 'Junior',
        sortOrder: 0,
      });
      expect(raised.audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'catalog.service.created' }),
      );
    });

    it('appends after its siblings and refuses a duplicate name under the same parent', async () => {
      const { service, tx } = fakeCatalog();
      jest.spyOn(service, 'adminNode').mockResolvedValue({} as never);
      await service.createService(user.id, {
        name: 'Roofing',
        icon: 'tabler-home',
      });
      expect(tx.catalogService.create.mock.calls[0][0].data).toMatchObject({
        parentId: null,
        depth: 0,
        sortOrder: 6,
      });
      await expect(
        service.createService(user.id, { name: ' hire ' }),
      ).rejects.toThrow('A service called "hire" already exists here.');
    });
  });

  describe('updateService', () => {
    it('returns 409 for a stale version', async () => {
      const { service } = fakeCatalog();
      await expect(
        service.updateService(user.id, 'svc:Hire', {
          version: 9,
          active: false,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('increments the version and treats an empty string as clearing', async () => {
      const { service, tx, catalog } = fakeCatalog();
      Object.assign(catalog.byId.get('svc:Hire')!, {
        description: 'Trades',
        icon: 'tabler-tools',
      });
      jest.spyOn(service, 'adminNode').mockResolvedValue({} as never);
      await service.updateService(user.id, 'svc:Hire', {
        version: 1,
        description: '',
        icon: '',
        active: false,
      });
      expect(tx.catalogService.update).toHaveBeenCalledWith({
        where: { id: 'svc:Hire' },
        data: {
          description: null,
          icon: null,
          active: false,
          version: { increment: 1 },
        },
      });
    });

    it('rewrites provider services, skills and pending changes when a root is renamed', async () => {
      const { service, tx } = fakeCatalog({
        profiles: [
          {
            id: 'p1',
            services: ['Hire', 'Design'],
            skills: { Hire: ['Mason'], Design: ['Interior design'] },
            pendingChanges: { services: ['Hire'], skills: { Hire: ['Mason'] } },
          },
          { id: 'p2', services: ['Design'], skills: [], pendingChanges: null },
        ],
      });
      jest.spyOn(service, 'adminNode').mockResolvedValue({} as never);
      await service.updateService(user.id, 'svc:Hire', {
        version: 1,
        name: 'Equipment and labour',
      });
      expect(tx.providerProfile.update).toHaveBeenCalledTimes(1);
      expect(tx.providerProfile.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: {
          services: ['Equipment and labour', 'Design'],
          skills: {
            'Equipment and labour': ['Mason'],
            Design: ['Interior design'],
          },
          pendingChanges: {
            services: ['Equipment and labour'],
            skills: { 'Equipment and labour': ['Mason'] },
          },
        },
      });
    });

    it('rewrites the root skills entry when a skill leaf is renamed but not when a skill-question parent is', async () => {
      const profiles = [
        {
          id: 'p1',
          services: ['Design'],
          skills: { Design: ['Interior design', 'Structural plan'] },
          pendingChanges: null,
        },
      ];
      const leaf = fakeCatalog({ profiles });
      jest.spyOn(leaf.service, 'adminNode').mockResolvedValue({} as never);
      await leaf.service.updateService(user.id, 'svc:Design/Interior design', {
        version: 1,
        name: 'Interior fit-out',
      });
      expect(leaf.tx.providerProfile.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: {
          services: ['Design'],
          skills: { Design: ['Interior fit-out', 'Structural plan'] },
        },
      });

      const parent = fakeCatalog({ profiles });
      jest.spyOn(parent.service, 'adminNode').mockResolvedValue({} as never);
      await parent.service.updateService(user.id, 'svc:Hire/Professional', {
        version: 1,
        name: 'Consultants',
      });
      expect(parent.tx.providerProfile.update).not.toHaveBeenCalled();
    });
  });

  describe('deleteService', () => {
    it('refuses a service with children or requests and deletes an unused leaf', async () => {
      const { service, tx } = fakeCatalog();
      await expect(service.deleteService(user.id, 'svc:Hire')).rejects.toThrow(
        'Delete its sub-services first',
      );
      const used = fakeCatalog({ requests: 2 });
      await expect(
        used.service.deleteService(user.id, 'svc:Design/Interior design'),
      ).rejects.toThrow('Requests already use this service');
      await expect(
        service.deleteService(user.id, 'svc:Design/Interior design'),
      ).resolves.toEqual({ id: 'svc:Design/Interior design' });
      expect(tx.catalogService.delete).toHaveBeenCalledWith({
        where: { id: 'svc:Design/Interior design' },
      });
      await expect(service.deleteService(user.id, 'missing')).rejects.toThrow(
        'Service not found.',
      );
    });
  });

  describe('reorderServices', () => {
    it('writes new positions only for siblings that moved and rejects a partial list', async () => {
      const { service, tx } = fakeCatalog();
      const ids = [
        'svc:Design/Interior design',
        'svc:Design/Architectural plan',
        'svc:Design/Structural plan',
      ];
      await service.reorderServices(user.id, { parentId: 'svc:Design', ids });
      expect(tx.catalogService.update.mock.calls.map(([arg]) => arg)).toEqual([
        { where: { id: ids[0] }, data: { sortOrder: 0 } },
        { where: { id: ids[1] }, data: { sortOrder: 1 } },
        { where: { id: ids[2] }, data: { sortOrder: 2 } },
      ]);
      await expect(
        service.reorderServices(user.id, {
          parentId: 'svc:Design',
          ids: ids.slice(1),
        }),
      ).rejects.toThrow('Send every item in the list exactly once.');
      await expect(
        service.reorderServices(user.id, {
          parentId: null,
          ids: ['svc:Design'],
        }),
      ).rejects.toThrow('exactly once');
    });
  });

  describe('saveSettings', () => {
    it('saves through the settings service with the catalog permission', async () => {
      const { service, settings } = fakeCatalog({ maxDepth: 2 });
      await expect(
        service.saveSettings(user, { maxDepth: 3 }),
      ).resolves.toEqual({
        maxDepth: 3,
      });
      expect(settings.save).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'staff-1' }),
        [{ key: 'catalog.maxDepth', value: 3, expectedVersion: 4 }],
        expect.any(String),
        undefined,
        'session-1',
        'catalog.manage',
      );
    });

    it('rejects lowering the limit below the deepest branch', async () => {
      const deep = indexOf([
        makeNode({
          id: 'a',
          name: 'A',
          children: [
            makeNode({
              id: 'b',
              name: 'B',
              parentId: 'a',
              depth: 1,
              children: [
                makeNode({ id: 'c', name: 'C', parentId: 'b', depth: 2 }),
              ],
            }),
          ],
        }),
      ]);
      const { service, settings } = fakeCatalog({ catalog: deep, maxDepth: 4 });
      await expect(service.saveSettings(user, { maxDepth: 2 })).rejects.toThrow(
        'The catalog already has 3 levels',
      );
      expect(settings.save).not.toHaveBeenCalled();
      await expect(
        fakeCatalog().service.saveSettings(user, { maxDepth: 2 }),
      ).resolves.toEqual({ maxDepth: 2 });
    });
  });

  describe('adminCatalog', () => {
    it('returns the limit and the full tree with usage counts', async () => {
      const { service, prisma, catalog } = fakeCatalog({
        profiles: [
          { services: ['Hire'], skills: { Hire: ['Mason'] } },
          {
            services: ['Hire', 'Design'],
            skills: { Hire: ['Excavator'], Design: ['Interior design'] },
          },
        ],
      });
      catalog.byId.get('svc:Design/Interior design')!.active = false;
      prisma.serviceRequest.groupBy
        .mockResolvedValueOnce([
          { serviceId: 'svc:Hire/Vocational worker', _count: { _all: 2 } },
          { serviceId: 'svc:Hire/Heavy equipment', _count: { _all: 1 } },
        ] as never)
        .mockResolvedValueOnce([
          { serviceRootId: 'svc:Hire', _count: { _all: 4 } },
        ] as never);
      const result = await service.adminCatalog(user.id);
      expect(result.maxDepth).toBe(2);
      const hire = result.services.find(({ name }) => name === 'Hire')!;
      expect(hire.usage).toEqual({ requests: 7, providers: 2 });
      const vocational = hire.children.find(
        ({ name }) => name === 'Vocational worker',
      )!;
      expect(vocational.usage).toEqual({ requests: 2, providers: 1 });
      expect(hire.children[2].usage.providers).toBe(1);
      const design = result.services.find(({ name }) => name === 'Design')!;
      expect(design.children.some(({ active }) => !active)).toBe(true);
      expect(design.usage.providers).toBe(1);
      expect(seededCatalog().roots).toHaveLength(6);
    });

    it('counts providers by stored ids, so renamed nodes and options still count', async () => {
      const excavator = 'svc:Hire/Heavy equipment:trade:Excavator';
      const { service, catalog } = fakeCatalog({
        profiles: [
          {
            services: ['Stale name'],
            skills: { 'Stale name': ['Stale skill'] },
            serviceIds: ['svc:Hire'],
            skillIds: { 'svc:Hire': [excavator] },
          },
          {
            services: ['Hire'],
            skills: { Hire: ['Excavator'] },
            serviceIds: ['svc:Design'],
            skillIds: { 'svc:Design': ['svc:Design/Structural plan'] },
          },
        ],
      });
      catalog.byId.get('svc:Hire')!.name = 'Hire and rental';
      catalog.byId.get(
        'svc:Hire/Heavy equipment',
      )!.questions[0].options[0].label = 'Excavator (20t)';
      const result = await service.adminCatalog(user.id);
      const hire = result.services.find(({ id }) => id === 'svc:Hire')!;
      expect(hire.usage.providers).toBe(1);
      expect(
        hire.children.map(({ name, usage }) => [name, usage.providers]),
      ).toEqual([
        ['Professional', 0],
        ['Vocational worker', 0],
        ['Heavy equipment', 1],
      ]);
      const design = result.services.find(({ id }) => id === 'svc:Design')!;
      expect(design.usage.providers).toBe(1);
      expect(
        design.children.map(({ name, usage }) => [name, usage.providers]),
      ).toEqual([
        ['Architectural plan', 0],
        ['Structural plan', 1],
        ['Interior design', 0],
      ]);
    });
  });
});
