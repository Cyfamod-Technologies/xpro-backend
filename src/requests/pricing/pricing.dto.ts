import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class QuoteLineDto {
  @IsString() @MinLength(1) @MaxLength(300) description!: string;
  @IsInt() @Min(1) quantity!: number;
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) unitPrice!: number;
}
export class QuoteItemsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => QuoteLineDto)
  items!: QuoteLineDto[];
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
export class EditQuoteDto extends QuoteItemsDto {
  @IsInt() @Min(1) revision!: number;
}
export class PublishQuoteDto {
  @IsInt() @Min(1) revision!: number;
  @IsOptional() @IsString() @MaxLength(1000) pricingOverrideNote?: string;
  @IsOptional() @IsString() @MaxLength(1000) customerNote?: string;
}
export class QuoteDecisionDto {
  @IsString() decision!: 'accepted' | 'revision_requested' | 'declined';
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
export class QuoteApprovalDto {
  @IsInt() @Min(1) revision!: number;
  @IsOptional() @IsString() @MaxLength(1000) selfApprovalReason?: string;
}
export class QuoteReturnDto {
  @IsInt() @Min(1) revision!: number;
  @IsString() @MinLength(5) @MaxLength(1000) note!: string;
}
export class PayoutAmountDto {
  @IsInt() @Min(1) @Max(Number.MAX_SAFE_INTEGER) payoutAmount!: number;
}
