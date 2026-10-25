import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class DispatchModeDto {
  @IsString() mode!: 'auto' | 'manual';
  @IsString() @MinLength(5) @MaxLength(500) note!: string;
}
export class AutoAssignDto {
  @IsOptional() @IsBoolean() resetAttempts?: boolean;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
export class OfferDto {
  @IsString() providerId!: string;
  @IsString() rankingRunId!: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsString() @MinLength(5) @MaxLength(500) overrideNote?: string;
}
export class AssignmentRespondDto {
  @IsBoolean() accept!: boolean;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(500) note?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) crewSize?: number;
}
export class ShareDto {
  @IsBoolean() description!: boolean;
  @IsArray() @IsString({ each: true }) attachmentIds!: string[];
}
export class AssignmentReviewDto {
  @IsBoolean() approve!: boolean;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @ValidateNested() @Type(() => ShareDto) share?: ShareDto;
  @IsOptional() @IsString() @MinLength(5) @MaxLength(500) overrideNote?: string;
}
export class AssignmentNoteDto {
  @IsString() @MinLength(5) @MaxLength(500) note!: string;
  @IsOptional() @IsBoolean() workStarted?: boolean;
}
export class ShareDetailsDto {
  @IsOptional() @IsArray() @IsString({ each: true }) fields?: string[];
  @IsOptional() @IsArray() @IsString({ each: true }) attachmentIds?: string[];
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
