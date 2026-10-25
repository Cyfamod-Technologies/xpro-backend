import {
  IsBoolean,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class InitiatePaymentDto {
  @IsIn(['paystack']) method!: 'paystack';
}
export class OfflinePaymentDto {
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) amount!: number;
  @IsIn(['bank_transfer', 'cash', 'cheque']) channel!:
    'bank_transfer' | 'cash' | 'cheque';
  @IsString() @MinLength(1) @MaxLength(200) reference!: string;
  @IsISO8601() paidAt!: string;
  // A missing proof is refused by the payment.recordOffline guard with the 05 §6.2 message.
  @IsOptional() @IsString() @MaxLength(100) proofFileId?: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
// The guards give blank notes and reasons their 05 §6.2 messages.
export class PaymentNoteDto {
  @IsString() @MaxLength(1000) note!: string;
}
export class RejectPaymentDto {
  @IsString() @MaxLength(1000) reason!: string;
}
export class RefundDecisionDto {
  @IsBoolean() approve!: boolean;
  @IsOptional() @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) amount?: number;
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
}
export class PayoutDecisionDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
export class FinanceNoteDto {
  @IsString() @MinLength(3) @MaxLength(1000) note!: string;
}
export class PayoutSecondApprovalDto {
  @IsBoolean() approve!: boolean;
  @IsString() @MinLength(3) @MaxLength(1000) note!: string;
}
export class PayoutHoldDto {
  @IsString() @MinLength(3) @MaxLength(1000) reason!: string;
}
export class OfflineTransferDto {
  @IsString() @MinLength(1) @MaxLength(200) reference!: string;
  @IsString() proofFileId!: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
export class PayoutTransferDto {
  @IsIn(['paystack', 'offline']) method!: 'paystack' | 'offline';
  @IsOptional() @IsString() reference?: string;
  @IsOptional() @IsString() proofFileId?: string;
}
