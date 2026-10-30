import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsDefined,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class PlatformSettingChangeDto {
  @ApiProperty()
  @IsString()
  key!: string;

  @ApiProperty({
    description: 'New setting value, validated for the selected key',
  })
  @IsDefined()
  value!: unknown;

  @ApiProperty()
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}

export class SavePlatformSettingsDto {
  @ApiProperty({ type: [PlatformSettingChangeDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PlatformSettingChangeDto)
  changes!: PlatformSettingChangeDto[];

  @ApiProperty()
  @IsString()
  reason!: string;
}

export class PlatformSettingsHistoryQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  key?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit = 25;
}
