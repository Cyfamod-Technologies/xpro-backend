import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/** No-op until Phase 9 supplies the approval queue deadline implementation. */
@Injectable()
export class ApprovalsHooks {
  async onSubmitted(_tx: Prisma.TransactionClient, _requestId: string, _now: Date): Promise<void> {}
}
