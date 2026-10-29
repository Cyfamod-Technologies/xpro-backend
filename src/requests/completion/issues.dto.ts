import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { AttachmentRefDto } from '../dto/attachment-ref.dto';

export class RaiseIssueDto {
  @IsString() @MinLength(1) @MaxLength(2000) note!: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => AttachmentRefDto)
  attachments?: AttachmentRefDto[];
}
export class IssueNoteDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
/** Shape only: the runner guard requires a note of 5 or more characters and returns the 02 §6.10 message. */
export class EscalateIssueDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
export class ResolveIssueDto {
  @IsIn(['no_rework', 'dispute_decision']) outcome!:
    'no_rework' | 'dispute_decision';
  @IsString() @MinLength(5) @MaxLength(1000) note!: string;
  @IsOptional() @IsBoolean() requireRework?: boolean;
}
