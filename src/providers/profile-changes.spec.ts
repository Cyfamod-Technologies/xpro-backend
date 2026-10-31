import { changedProfileFields } from './profile-changes';

const live = {
  trade: 'Plumbing',
  services: ['Plumbing'],
  serviceIds: ['svc-1'],
  serviceAreaIds: ['a-1', 'a-2'],
  skills: { Plumbing: ['Pipe fitting'] },
  skillIds: { 'svc-1': ['sk-1'] },
  capacity: 3,
  documents: [{ id: 'd-1', name: 'id.pdf' }],
  photo: { id: 'p-1' },
};

describe('changedProfileFields', () => {
  it('reports nothing when nothing changed, whatever the order', () => {
    expect(
      changedProfileFields(live, {
        ...live,
        serviceAreaIds: ['a-2', 'a-1'],
      }),
    ).toEqual([]);
  });

  it('names each changed sensitive field', () => {
    expect(
      changedProfileFields(live, {
        ...live,
        trade: 'Electrical',
        serviceIds: ['svc-1', 'svc-2'],
        serviceAreaIds: ['a-1'],
        skillIds: { 'svc-1': ['sk-1', 'sk-2'] },
        capacity: 5,
        documents: [{ id: 'd-2' }],
        photo: { id: 'p-2' },
      }),
    ).toEqual([
      'Trade',
      'Services',
      'Service areas',
      'Skills',
      'Job capacity',
      'Verification documents',
      'Face photo',
    ]);
  });

  it('falls back to names for profiles saved without ids', () => {
    const old = { ...live, serviceIds: null, skillIds: null };
    expect(
      changedProfileFields(old, {
        ...old,
        services: ['Plumbing', 'Tiling'],
        skills: { Plumbing: ['Pipe fitting', 'Drainage'] },
      }),
    ).toEqual(['Services', 'Skills']);
  });
});
