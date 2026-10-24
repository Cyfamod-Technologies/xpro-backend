import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class HoldRequestDto {
  @IsString() @MinLength(5) @MaxLength(500) reason!: string;
  @IsIn(['staff', 'no_show', 'provider_suspended', 'customer_suspended']) kind!: 'staff' | 'no_show' | 'provider_suspended' | 'customer_suspended';
  @IsOptional() @IsString() @MaxLength(500) customerNote?: string;
}

export class ReleaseHoldDto {
  @IsString() @MinLength(3) @MaxLength(1000) note!: string;
}
