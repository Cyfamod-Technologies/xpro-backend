import {
  checkProgressAdd,
  deriveProgressKind,
  progressEvidenceSatisfied,
  type ProgressAddCheckInput,
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

describe('checkProgressAdd (04 §6.14 check table)', () => {
  const NOW = new Date('2026-10-26T10:00:00.000Z');
  const START = new Date('2026-10-26T12:00:00.000Z');
  const base: ProgressAddCheckInput = {
    status: 'in_progress',
    note: 'Started the electrical first fix.',
    requestStatus: 'in_progress',
    assignmentAccepted: true,
    confirmedStartAt: START,
    onHold: false,
    unresolvedIssues: [],
    hasCurrentAttachments: false,
    hasApprovedCurrentAssignmentEvidence: false,
    pendingKinds: [],
    now: NOW,
  };
  const run = (overrides: Partial<ProgressAddCheckInput> = {}) =>
    checkProgressAdd({ ...base, ...overrides });
  const refused = (status: number, code: string, message: string) => ({
    ok: false,
    status,
    code,
    message,
  });
  const conflict = (message: string) => refused(409, 'STATE_CONFLICT', message);

  it.each([
    ['start', { requestStatus: 'scheduled' as const }],
    ['progress', {}],
    ['blocker', { status: 'blocked' }],
    ['resume', { requestStatus: 'blocked' as const }],
    [
      'completion',
      { status: 'completion_pending', hasCurrentAttachments: true },
    ],
  ])('derives %s', (kind, overrides) => {
    expect(
      run({ ...overrides, now: new Date('2026-10-26T10:00:00Z') }),
    ).toMatchObject({ ok: true, kind, issueId: null });
  });

  it('derives rework and rework_completion from the linked issue', () => {
    const issue = { id: 'issue-1', status: 'rework' as const };
    expect(
      run({ unresolvedIssues: [issue], issueId: 'issue-1' }),
    ).toMatchObject({ ok: true, kind: 'rework', issueId: 'issue-1' });
    expect(
      run({
        status: 'completion_pending',
        unresolvedIssues: [issue],
        issueId: 'issue-1',
        hasCurrentAttachments: true,
      }),
    ).toMatchObject({
      ok: true,
      kind: 'rework_completion',
      issueId: 'issue-1',
    });
  });

  it('row 1: status must be one of the three', () => {
    expect(run({ status: 'done' })).toEqual(
      refused(422, 'VALIDATION_ERROR', 'Choose a valid update type.'),
    );
    expect(run({ status: undefined })).toMatchObject({
      ok: false,
      status: 422,
    });
  });

  it('row 2: the current assignment must be held and accepted', () => {
    expect(run({ assignmentAccepted: false })).toEqual(
      conflict('Accept the current assignment before updating this job.'),
    );
  });

  it('row 3: the current schedule must be confirmed', () => {
    expect(run({ confirmedStartAt: null })).toEqual(
      conflict('Confirm the schedule before starting work.'),
    );
  });

  it.each(['', '  ab  ', 'x'.repeat(2001), undefined])(
    'row 4: note %p is 3 to 2000 characters',
    (note) => {
      expect(run({ note })).toEqual(
        refused(422, 'VALIDATION_ERROR', 'Add a progress note.'),
      );
    },
  );

  it('row 4: 3 and 2000 characters pass', () => {
    expect(run({ note: 'abc' })).toMatchObject({ ok: true });
    expect(run({ note: 'x'.repeat(2000) })).toMatchObject({ ok: true });
  });

  it.each(['submitted', 'ready_to_schedule', 'completion_pending', 'closed'])(
    'row 5: %s is not open for execution updates',
    (requestStatus) => {
      expect(run({ requestStatus: requestStatus as never })).toEqual(
        conflict('This job is not open for execution updates.'),
      );
    },
  );

  it('row 6: a staff hold pauses the provider', () => {
    expect(run({ requestStatus: 'blocked', onHold: true })).toEqual(
      conflict(
        'XPro has paused this job. Message XPro Dispatch before continuing.',
      ),
    );
  });

  it.each(['open', 'disputed'] as const)(
    'row 7: an %s issue holds the provider back',
    (status) => {
      expect(
        run({
          requestStatus: 'blocked',
          unresolvedIssues: [{ id: 'i1', status }],
        }),
      ).toEqual(
        conflict(
          'XPro is resolving the issue reported at completion. You can update the job once it is resolved.',
        ),
      );
    },
  );

  it('row 8: a rework issue needs the link, whatever issueId points at', () => {
    const unresolvedIssues = [{ id: 'i1', status: 'rework' as const }];
    const message = 'Link this update to the issue you are fixing.';
    expect(run({ unresolvedIssues })).toEqual(conflict(message));
    expect(run({ unresolvedIssues, issueId: 'other' })).toEqual(
      conflict(message),
    );
    expect(
      run({
        unresolvedIssues,
        status: 'completion_pending',
        hasCurrentAttachments: true,
      }),
    ).toEqual(conflict(message));
  });

  it('row 8: a blocker during rework needs no link; an issueId with no rework issue is not linked', () => {
    expect(
      run({
        status: 'blocked',
        unresolvedIssues: [{ id: 'i1', status: 'rework' }],
      }),
    ).toMatchObject({ ok: true, kind: 'blocker', issueId: null });
    expect(run({ issueId: 'i-resolved' })).toMatchObject({
      ok: true,
      kind: 'progress',
      issueId: null,
    });
  });

  it('row 9: a start is refused before startAt minus 2 h, showing that time in WAT', () => {
    const early = run({
      requestStatus: 'scheduled',
      now: new Date('2026-10-26T09:59:59Z'),
    });
    expect(early).toEqual(conflict('You can start this job from 11:00 WAT.'));
    expect(
      run({
        requestStatus: 'scheduled',
        now: new Date('2026-10-26T10:00:00Z'),
      }),
    ).toMatchObject({ ok: true, kind: 'start' });
  });

  it('row 9: the early-start row is skipped for staff', () => {
    expect(
      run({
        requestStatus: 'scheduled',
        now: new Date('2026-10-25T10:00:00Z'),
        staffOverride: true,
      }),
    ).toMatchObject({ ok: true, kind: 'start' });
  });

  it('row 10: a blocker needs work in progress', () => {
    for (const requestStatus of ['scheduled', 'blocked'] as const)
      expect(run({ status: 'blocked', requestStatus })).toEqual(
        conflict('Start the job before reporting a blocker.'),
      );
  });

  it('row 11: a completion needs work in progress', () => {
    for (const requestStatus of ['scheduled', 'blocked'] as const)
      expect(run({ status: 'completion_pending', requestStatus })).toEqual(
        conflict('Resume or start work before reporting completion.'),
      );
  });

  it('row 12: a completion needs evidence on this update or an approved one of the assignment', () => {
    const message = 'Attach work evidence before reporting completion.';
    expect(run({ status: 'completion_pending' })).toEqual(conflict(message));
    expect(
      run({ status: 'completion_pending', hasCurrentAttachments: true }),
    ).toMatchObject({ ok: true, kind: 'completion' });
    expect(
      run({
        status: 'completion_pending',
        hasApprovedCurrentAssignmentEvidence: true,
      }),
    ).toMatchObject({ ok: true, kind: 'completion' });
  });

  it('row 13: another pending update must be reviewed first, except a blocker replaces routine ones', () => {
    const message = 'Wait for XPro to review your previous update.';
    expect(run({ pendingKinds: ['progress'] })).toEqual(conflict(message));
    expect(
      run({
        status: 'completion_pending',
        hasCurrentAttachments: true,
        pendingKinds: ['progress'],
      }),
    ).toEqual(conflict(message));
    for (const kind of ['start', 'progress', 'resume', 'rework'] as const)
      expect(run({ status: 'blocked', pendingKinds: [kind] })).toMatchObject({
        ok: true,
        kind: 'blocker',
        replacesPending: true,
      });
    expect(run({ status: 'blocked', pendingKinds: ['blocker'] })).toEqual(
      conflict(message),
    );
    expect(
      run({ status: 'blocked', pendingKinds: ['progress', 'completion'] }),
    ).toEqual(conflict(message));
  });

  it('row 13: the one-pending row is skipped for staff', () => {
    expect(
      run({ pendingKinds: ['completion'], staffOverride: true }),
    ).toMatchObject({ ok: true, replacesPending: false });
  });

  it('keeps the table order: schedule before note, note before status', () => {
    expect(
      run({ confirmedStartAt: null, note: '', requestStatus: 'closed' }),
    ).toEqual(conflict('Confirm the schedule before starting work.'));
    expect(run({ note: '', requestStatus: 'closed' })).toEqual(
      refused(422, 'VALIDATION_ERROR', 'Add a progress note.'),
    );
  });
});
