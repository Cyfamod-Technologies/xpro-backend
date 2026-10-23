import { matchLocationName } from './location-matching';

const locations = [
  {
    id: 'city',
    kind: 'city',
    name: 'Abuja (FCT)',
    aliases: ['Abuja Municipal'],
  },
  { id: 'district', kind: 'district', name: 'Wuse II', aliases: ['Wuse 2'] },
];

describe('matchLocationName', () => {
  it('matches names and aliases case-insensitively', () => {
    expect(matchLocationName('wUsE 2', locations)?.id).toBe('district');
    expect(matchLocationName('ABUJA MUNICIPAL', locations)?.id).toBe('city');
  });

  it('can restrict matches to a location kind', () => {
    expect(matchLocationName('Abuja Municipal', locations, 'district')).toBeUndefined();
  });

  it('returns no match for unknown legacy values', () => {
    expect(matchLocationName('Kano', locations)).toBeUndefined();
  });
});
