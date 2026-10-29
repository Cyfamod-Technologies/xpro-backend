import {
  LAST_EDITOR_MESSAGE,
  requiresSignOff,
  SELF_APPROVAL_REASON_MESSAGE,
  selfApprovalFailure,
} from './quote-signoff';

describe('requiresSignOff (04 §6.11 sign-off)', () => {
  const base = {
    threshold: 100_000,
    total: 250_000n,
    holdsApprove: false,
    lastEditedBy: 'staff-1',
    actorId: 'staff-1',
  };

  it('publishes directly when no threshold is set', () => {
    expect(requiresSignOff({ ...base, threshold: null })).toBe(false);
    expect(requiresSignOff({ ...base, threshold: undefined })).toBe(false);
  });

  it('publishes directly below the threshold', () => {
    expect(requiresSignOff({ ...base, total: 99_999n })).toBe(false);
  });

  it('holds a quote at or above the threshold for a plain quote.manage holder', () => {
    expect(requiresSignOff({ ...base, total: 100_000n })).toBe(true);
    expect(requiresSignOff(base)).toBe(true);
  });

  it('lets a quote.approve holder bypass only when they are not the last editor (B-16)', () => {
    expect(
      requiresSignOff({ ...base, holdsApprove: true, actorId: 'approver-1' }),
    ).toBe(false);
    expect(requiresSignOff({ ...base, holdsApprove: true })).toBe(true);
  });

  it('applies to super admins like anyone else when they edited last', () => {
    expect(
      requiresSignOff({ ...base, holdsApprove: true, actorId: 'staff-1' }),
    ).toBe(true);
  });
});

describe('selfApprovalFailure (04 §6.11 approve rows 3 and 4, 02 §6.12)', () => {
  const base = {
    lastEditedBy: 'staff-1',
    actorId: 'staff-1',
    isSuperAdmin: true,
    activeSuperAdminIds: ['staff-1'],
    reason: 'Only admin on duty.',
  };

  it('passes for an approver who did not edit last', () => {
    expect(
      selfApprovalFailure({
        ...base,
        actorId: 'approver-1',
        reason: undefined,
      }),
    ).toEqual({ ok: true });
  });

  it('refuses the last editor when other approvers exist', () => {
    const refused = {
      ok: false,
      status: 409,
      code: 'STATE_CONFLICT',
      message: LAST_EDITOR_MESSAGE,
    };
    expect(LAST_EDITOR_MESSAGE).toBe(
      'You edited this quote last. Another approver must sign it off.',
    );
    expect(
      selfApprovalFailure({
        ...base,
        activeSuperAdminIds: ['staff-1', 'staff-2'],
      }),
    ).toEqual(refused);
  });

  it('refuses a last editor who is not a super admin even when alone in the list', () => {
    expect(selfApprovalFailure({ ...base, isSuperAdmin: false })).toMatchObject(
      { status: 409, message: LAST_EDITOR_MESSAGE },
    );
  });

  it('refuses when the sole active super admin is someone else', () => {
    expect(
      selfApprovalFailure({ ...base, activeSuperAdminIds: ['staff-9'] }),
    ).toMatchObject({ status: 409, message: LAST_EDITOR_MESSAGE });
    expect(
      selfApprovalFailure({ ...base, activeSuperAdminIds: [] }),
    ).toMatchObject({ status: 409 });
  });

  it('lets the sole active super admin self-approve with a reason', () => {
    expect(selfApprovalFailure(base)).toEqual({ ok: true });
  });

  it('asks the sole super admin for a reason', () => {
    for (const reason of [undefined, '', '   '])
      expect(selfApprovalFailure({ ...base, reason })).toEqual({
        ok: false,
        status: 422,
        code: 'VALIDATION_ERROR',
        message: SELF_APPROVAL_REASON_MESSAGE,
      });
  });
});
