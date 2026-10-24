import type { RequestStatus } from './statuses';
import type { UpdateKind } from '@prisma/client';

export type ProgressInputStatus = 'in_progress' | 'blocked' | 'completion_pending';

export function deriveProgressKind(input: {
  status: ProgressInputStatus;
  requestStatus: RequestStatus;
  issueStatus?: 'open' | 'rework' | 'disputed' | 'resolved';
  issueId?: string;
}): UpdateKind | null {
  if (input.status === 'blocked' && input.requestStatus === 'in_progress') return 'blocker';
  if (input.status === 'in_progress') {
    if (input.requestStatus === 'scheduled') return 'start';
    if (input.requestStatus === 'blocked') return 'resume';
    if (input.requestStatus !== 'in_progress') return null;
    if (input.issueStatus === 'rework' && input.issueId) return 'rework';
    if (input.issueStatus === 'rework') return null;
    return 'progress';
  }
  if (input.status === 'completion_pending' && input.requestStatus === 'in_progress') {
    if (input.issueStatus === 'rework' && input.issueId) return 'rework_completion';
    if (input.issueStatus === 'rework') return null;
    return 'completion';
  }
  return null;
}

export function progressEvidenceSatisfied(input: {
  hasCurrentAttachments: boolean;
  hasApprovedCurrentAssignmentEvidence: boolean;
}): boolean {
  return input.hasCurrentAttachments || input.hasApprovedCurrentAssignmentEvidence;
}
