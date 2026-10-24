import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RaiseIssueDto {
  @IsString() @MinLength(1) @MaxLength(2000) note!: string;
}
export class IssueNoteDto {
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}
export class ResolveIssueDto {
  @IsIn(['no_rework', 'dispute_decision']) outcome!:
    'no_rework' | 'dispute_decision';
  @IsString() @MinLength(5) @MaxLength(1000) note!: string;
  @IsOptional() @IsBoolean() requireRework?: boolean;
}
