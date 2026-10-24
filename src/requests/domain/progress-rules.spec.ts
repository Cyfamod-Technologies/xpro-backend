import {
  deriveProgressKind,
  progressEvidenceSatisfied,
} from './progress-rules';

describe('progress rules', () => {
  it('derives the update kind from the current request and issue states', () => {
    expect(
      deriveProgressKind({ status: 'in_progress', requestStatus: 'scheduled' }),
    ).toBe('start');
    expect(
      deriveProgressKind({ status: 'blocked', requestStatus: 'in_progress' }),
    ).toBe('blocker');
    expect(
      deriveProgressKind({
        status: 'completion_pending',
        requestStatus: 'in_progress',
        issueStatus: 'rework',
        issueId: 'i1',
      }),
    ).toBe('rework_completion');
    expect(
      deriveProgressKind({
        status: 'in_progress',
        requestStatus: 'in_progress',
        issueStatus: 'rework',
      }),
    ).toBeNull();
  });

  it('requires current or approved assignment evidence', () => {
    expect(
      progressEvidenceSatisfied({
        hasCurrentAttachments: false,
        hasApprovedCurrentAssignmentEvidence: false,
      }),
    ).toBe(false);
    expect(
      progressEvidenceSatisfied({
        hasCurrentAttachments: false,
        hasApprovedCurrentAssignmentEvidence: true,
      }),
    ).toBe(true);
  });
});
