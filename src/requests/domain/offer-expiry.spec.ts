import { offerExpiry } from './offer-expiry';

describe('offerExpiry', () => {
  it('extends the expiry to four provider working hours when the base window contains none', () => {
    const result = offerExpiry(new Date('2026-10-23T17:00:00.000Z'), 24, 4, {
      mon: { start: '08:00', end: '17:00' }, tue: { start: '08:00', end: '17:00' },
      wed: { start: '08:00', end: '17:00' }, thu: { start: '08:00', end: '17:00' },
      fri: { start: '08:00', end: '17:00' },
    }, []);
    expect(result.toISOString()).toBe('2026-10-26T11:00:00.000Z');
  });
});
