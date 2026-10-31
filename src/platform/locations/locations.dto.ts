import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
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

  @ApiPropertyOptional({
    description:
      'Only places that are served: the place and every ancestor are active and serviceable.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' || value === '1' || value === true
      ? true
      : value === 'false' || value === '0' || value === false
        ? false
        : value,
  )
  @IsBoolean()
  serviceable?: boolean;
}

export class SaveLocationDto {
  @ApiProperty({ enum: ['state', 'lga', 'area'] })
  @IsIn(['state', 'lga', 'area'])
  kind: 'state' | 'lga' | 'area';

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

  @ApiProperty({
    description:
      'Customers can request this place when it and every ancestor are active and serviceable.',
  })
  @IsBoolean()
  serviceable: boolean;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sort: number;
}
