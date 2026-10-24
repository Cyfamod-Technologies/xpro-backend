import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

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
  @IsOptional() @IsArray() @IsString({ each: true }) overrideRules?: string[];
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsString() @MinLength(5) @MaxLength(500) overrideNote?: string;
}
export class AssignmentRespondDto {
  @IsBoolean() accept!: boolean;
  @IsOptional() @IsString() @MinLength(3) @MaxLength(500) note?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) crewSize?: number;
}
export class AssignmentReviewDto {
  @IsBoolean() approve!: boolean;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() share?: { description: string; attachmentIds: string[] };
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
