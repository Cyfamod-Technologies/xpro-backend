import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class LocationListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  parentId?: string;
}

export class SaveLocationDto {
  @ApiProperty({ enum: ['city', 'district'] })
  @IsIn(['city', 'district'])
  kind: 'city' | 'district';

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  aliases: string[];

  @ApiProperty()
  @IsBoolean()
  active: boolean;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sort: number;
}
