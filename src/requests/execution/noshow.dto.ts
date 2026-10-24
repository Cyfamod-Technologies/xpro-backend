import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

export class RecordNoShowDto {
  @IsString() scheduleId!: string;
  @IsString() @MinLength(5) @MaxLength(2000) note!: string;
}

export class DecideNoShowDto {
  @IsOptional() @IsIn(['confirm', 'dismiss']) outcome?: 'confirm' | 'dismiss';
  @IsString() @MinLength(5) @MaxLength(1000) note!: string;
  @IsInt() @Min(1) version!: number;
}
