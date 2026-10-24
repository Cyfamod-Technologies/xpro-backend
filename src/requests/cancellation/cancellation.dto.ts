import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RequestCancellationDto {
  @IsIn([
    'customer_changed_mind',
    'quote_declined',
    'no_response',
    'payment_lapsed',
    'no_provider',
    'provider_no_show',
    'provider_suspended',
    'customer_suspended',
    'scope_dispute',
    'duplicate',
    'other',
  ])
  reasonCode!: string;
  @IsString() @MinLength(5) @MaxLength(1000) note!: string;
}

export class DecideCancellationDto {
  @IsBoolean() approve!: boolean;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class WithdrawCancellationDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
