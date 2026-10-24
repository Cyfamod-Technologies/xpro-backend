import { Transform, Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { REQUEST_STATUSES } from '../domain/statuses';
import { serviceLines } from '../../platform/catalog/service-lines';

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
  @ApiPropertyOptional({ description: 'Staff-only owner filter' })
  @IsOptional()
  @IsString()
  owner?: string;
  @ApiPropertyOptional({ enum: REQUEST_STATUSES })
  @IsOptional()
  @IsIn(REQUEST_STATUSES)
  status?: string;
  @ApiPropertyOptional({ enum: REQUEST_STAGES })
  @IsOptional()
  @IsIn(REQUEST_STAGES)
  stage?: string;
  @ApiPropertyOptional({ enum: serviceLines })
  @IsOptional()
  @IsIn(serviceLines)
  service?: string;
  @ApiPropertyOptional({ description: 'Search by request id or title' })
  @IsOptional()
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : (value as unknown),
  )
  q?: string;
  @ApiPropertyOptional({ enum: ['me'] })
  @IsOptional()
  @IsIn(['me'])
  nextActor?: 'me';
}
