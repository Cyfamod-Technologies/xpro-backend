import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AttachmentRefDto } from '../dto/attachment-ref.dto';

export class CompletionResponseDto {
  @IsBoolean() acknowledge!: boolean;
  @IsOptional() @IsString() @MaxLength(2000) note?: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => AttachmentRefDto)
  attachments?: AttachmentRefDto[];
}

export class ConfirmOnBehalfDto {
  @IsString() @MinLength(5) @MaxLength(1000) note!: string;
}
