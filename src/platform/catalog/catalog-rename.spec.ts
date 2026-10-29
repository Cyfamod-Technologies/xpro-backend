import { renameInProfile } from './catalog-rename';

describe('renameInProfile', () => {
  it('renames a root in services, the skills key and keeps order without duplicates', () => {
    expect(
      renameInProfile(
        {
          services: ['Design', 'Hire'],
          skills: { Hire: ['Mason'], Design: [] },
        },
        { root: null, from: 'Hire', to: 'Design' },
      ),
    ).toEqual({
      services: ['Design'],
      skills: { Design: [] },
    });
  });

  it('renames a skill only under its root and tolerates the legacy empty-array skills', () => {
    expect(
      renameInProfile(
        { services: ['Hire'], skills: { Hire: ['Mason'], Design: ['Mason'] } },
        { root: 'Hire', from: 'Mason', to: 'Bricklayer' },
      ).skills,
    ).toEqual({ Hire: ['Bricklayer'], Design: ['Mason'] });
    expect(
      renameInProfile(
        { services: ['Hire'], skills: [] },
        { root: 'Hire', from: 'Mason', to: 'Bricklayer' },
      ).skills,
    ).toEqual([]);
  });
});
