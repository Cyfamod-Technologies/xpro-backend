import { Injectable, OnModuleInit } from '@nestjs/common';
import { ActorService } from '../platform/actor/actor.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  PAYMENT_ENTITY,
  PAYOUT_ENTITY,
  REFUND_ENTITY,
} from '../uploads/entity-types';
import { FileAccessService } from '../uploads/file-access.service';
import { mayAccessProof, type ProofEntity } from './domain/proof-access';

/** Download access for payment, refund and payout proof files (the uploads are attached with these entity types). */
@Injectable()
export class PaymentsFileAccess implements OnModuleInit {
  constructor(
    private readonly access: FileAccessService,
    private readonly prisma: PrismaService,
    private readonly actors: ActorService,
  ) {}

  onModuleInit(): void {
    this.register(PAYMENT_ENTITY, 'payment', (id) =>
      this.prisma.payment.findUnique({ where: { id }, select: { id: true } }),
    );
    this.register(REFUND_ENTITY, 'refund', (id) =>
      this.prisma.refund.findUnique({ where: { id }, select: { id: true } }),
    );
    this.register(PAYOUT_ENTITY, 'payout', (id) =>
      this.prisma.payout.findUnique({ where: { id }, select: { id: true } }),
    );
  }

  private register(
    entityType: string,
    proof: ProofEntity,
    exists: (id: string) => Promise<unknown>,
  ): void {
    this.access.register(entityType, async (user, upload) => {
      if (!upload.entityId) return false;
      const actor = await this.actors.resolve(user.id);
      if (!mayAccessProof(proof, actor)) return false;
      return !!(await exists(upload.entityId));
    });
  }
}
