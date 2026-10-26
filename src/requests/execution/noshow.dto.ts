import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class RecordNoShowDto {
  @IsString() scheduleId!: string;
  @IsString() @MinLength(5) @MaxLength(2000) note!: string;
  /** Ids of ready `progress_evidence` uploads (04 §6.16, plan §E.6). */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsString({ each: true })
  evidenceIds?: string[];
}

export class DecideNoShowDto {
  @IsOptional() @IsIn(['confirm', 'dismiss']) outcome?: 'confirm' | 'dismiss';
  @IsString() @MinLength(5) @MaxLength(1000) note!: string;
  @IsInt() @Min(1) version!: number;
}
