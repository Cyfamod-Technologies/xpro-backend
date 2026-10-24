import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class AddProgressDto {
  @IsIn(['in_progress', 'blocked', 'completion_pending']) status!:
    'in_progress' | 'blocked' | 'completion_pending';
  @IsString() @MinLength(3) @MaxLength(2000) note!: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  attachments: string[] = [];
  @IsOptional() @IsString() issueId?: string;
}

export class ReviewProgressDto {
  @IsIn([true, false]) approve!: boolean;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class AddProgressOnBehalfDto {
  @IsIn(['in_progress', 'blocked', 'completion_pending']) status!:
    'in_progress' | 'blocked' | 'completion_pending';
  @IsString() @MinLength(3) @MaxLength(2000) note!: string;
  @IsString() @MinLength(3) @MaxLength(1000) reportedVia!: string;
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  attachments: string[] = [];
  @IsOptional() @IsString() issueId?: string;
}
