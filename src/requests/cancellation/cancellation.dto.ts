import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Allow,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { CANCELLATION_REASON_CODES } from '../domain/cancellation-rules';

/** `POST /requests/:id/cancel` (04 §11.2). The note's length and the staff-only `reasonCode` requirement are checked by the guards (plan C.7). */
export class CancelRequestDto {
  @ApiProperty({ maxLength: 1000 }) @Allow() note!: string;
  @ApiPropertyOptional({ enum: CANCELLATION_REASON_CODES })
  @IsOptional()
  @IsIn(CANCELLATION_REASON_CODES)
  reasonCode?: string;
}

export class DecideCancellationDto {
  @IsBoolean() approve!: boolean;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class WithdrawCancellationDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
