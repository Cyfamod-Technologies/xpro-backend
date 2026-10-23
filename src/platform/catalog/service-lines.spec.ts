import {
  hireTradeGroups,
  intakeFields,
  serviceLines,
  serviceSkills,
  skillFieldKey,
} from './service-lines';

describe('service catalogue', () => {
  it('defines all six API service lines and required skill fields', () => {
    expect(serviceLines).toHaveLength(6);
    for (const service of serviceLines) {
      const skillField = intakeFields[service].find(
        ({ key }) => key === skillFieldKey[service],
      );
      expect(skillField).toMatchObject({ required: true, isSkill: true });
      expect(skillField?.options?.length).toBeGreaterThan(0);
    }
  });

  it('makes Procurement category required and Waste access sensitive', () => {
    expect(intakeFields.Procurement.find(({ key }) => key === 'category')?.required).toBe(true);
    expect(intakeFields['Waste management'].find(({ key }) => key === 'access'))
      .toMatchObject({ required: true, sensitive: true });
  });

  it('covers each Hire trade exactly once across the three groups', () => {
    const trades = Object.values(hireTradeGroups).flat();
    expect(trades).toHaveLength(22);
    expect(new Set(trades).size).toBe(22);
    expect([...trades].sort()).toEqual([...serviceSkills.Hire].sort());
  });

  it('marks Hire quantity as a number and includes the stated range', () => {
    expect(intakeFields.Hire.find(({ key }) => key === 'quantity')).toMatchObject({
      type: 'number',
      min: 1,
      max: 10,
      integer: true,
    });
  });
});
