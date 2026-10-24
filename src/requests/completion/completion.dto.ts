import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CompletionResponseDto {
  @IsBoolean() acknowledge!: boolean;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
}

export class ConfirmOnBehalfDto {
  @IsString() @MinLength(5) @MaxLength(1000) note!: string;
}
