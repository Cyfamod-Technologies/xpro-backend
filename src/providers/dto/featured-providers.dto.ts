import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class FeaturedProvidersUpdateDto {
  @ApiProperty({
    description:
      'Revision returned by the last GET; stale values are rejected.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  revision: string;

  @ApiProperty({
    type: [String],
    description: 'Ordered provider profile ids to pin (first is shown first).',
  })
  @IsArray()
  @ArrayMaxSize(12)
  @ArrayUnique()
  @IsString({ each: true })
  pinned: string[];

  @ApiProperty({
    type: [String],
    description: 'Provider profile ids that must never be featured.',
  })
  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsString({ each: true })
  hidden: string[];
}
