import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CloseRequestDto {
  @IsOptional() @IsString() @MinLength(5) @MaxLength(1000) note?: string;
}
