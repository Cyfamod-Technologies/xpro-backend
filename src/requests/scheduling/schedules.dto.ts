import {
  IsBoolean,
  IsDateString,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ProposeScheduleDto {
  @IsDateString() startAt!: string;
  @IsDateString() endAt!: string;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class RespondScheduleDto {
  @IsBoolean() accept!: boolean;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class RequestScheduleChangeDto {
  @IsString() @MinLength(5) @MaxLength(500) note!: string;
}
