import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { REQUEST_STATUSES } from '../domain/statuses';

export const REQUEST_STAGES = [
  'intake_review',
  'awaiting_clarification',
  'dispatching',
  'offer_out',
  'acceptance_review',
  'replacing_provider',
  'pricing',
  'quote_approval',
  'quote_revision',
  'quote_expired',
  'payment_lapsed',
  'quote_with_customer',
  'awaiting_payment',
  'set_payout',
  'scheduling',
  'schedule_proposed',
  'schedule_changes',
  'scheduled',
  'reschedule',
  'in_progress',
  'rework',
  'blocked_provider',
  'on_hold',
  'issue_open',
  'dispute',
  'awaiting_customer_confirmation',
  'defects_window',
  'ready_to_close',
  'closed',
  'refund_pending',
  'cancelled',
  'rejected',
] as const;

export const REQUEST_SORTS = [
  'createdAt:desc',
  'createdAt:asc',
  'updatedAt:desc',
  'id:asc',
] as const;
export type RequestSort = (typeof REQUEST_SORTS)[number];

export class RequestListQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;
  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  itemsPerPage = 20;
  @ApiPropertyOptional({
    description:
      'Staff-only owner filter: `all` (no filter), `mine`, `unclaimed`, or a staff user id. Ignored for other callers.',
    example: 'mine',
  })
  @IsOptional()
  @IsString()
  owner?: string;
  @ApiPropertyOptional({ enum: REQUEST_STATUSES })
  @IsOptional()
  @IsIn(REQUEST_STATUSES)
  status?: string;
  @ApiPropertyOptional({
    enum: REQUEST_STAGES,
    description:
      "Narrowed in SQL to the stage's status, then matched on the derived stage within the first 100 matching requests (see `nextActor`).",
  })
  @IsOptional()
  @IsIn(REQUEST_STAGES)
  stage?: string;
  @ApiPropertyOptional({ description: 'Top-level service name' })
  @IsOptional()
  @IsString()
  service?: string;
  @ApiPropertyOptional({ description: 'Top-level catalog service id' })
  @IsOptional()
  @IsUUID()
  serviceRootId?: string;
  @ApiPropertyOptional({
    description:
      "Only the requests of one multi-service submission: a group id or `XPG-nnnnn`. Narrows the caller's own scope; an unknown group returns an empty page. Ignored for providers.",
    example: 'XPG-00012',
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : (value as unknown),
  )
  group?: string;
  @ApiPropertyOptional({ description: 'Search by request id or title' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : (value as unknown),
  )
  q?: string;
  @ApiPropertyOptional({
    enum: ['me'],
    description:
      'Derived per request, so `stage`, `nextActor` and provider `q` filter within the first 100 matching requests (one maximum-size page); `total` counts matches in that window.',
  })
  @IsOptional()
  @IsIn(['me'])
  nextActor?: 'me';
  @ApiPropertyOptional({
    enum: REQUEST_SORTS,
    default: 'createdAt:desc',
    description:
      'Sort order. Ties are always broken by `id` in the same direction.',
  })
  @IsOptional()
  @IsIn(REQUEST_SORTS)
  sort?: RequestSort;
}
