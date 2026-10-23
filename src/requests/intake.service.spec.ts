import { trigramSimilarity } from './intake.service';

describe('trigramSimilarity', () => {
  it('flags identical and near-identical request titles at the configured threshold', () => {
    expect(trigramSimilarity('Repair leaking roof', 'Repair leaking roof')).toBe(1);
    expect(trigramSimilarity('Repair leaking roof', 'Repair leaking roofs')).toBeGreaterThanOrEqual(0.6);
  });

  it('does not flag unrelated titles', () => {
    expect(trigramSimilarity('Repair leaking roof', 'Buy office chairs')).toBeLessThan(0.6);
  });
});
