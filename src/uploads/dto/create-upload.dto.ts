import { UploadPurpose } from '@prisma/client';
import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsInt, IsString, Max, MaxLength, Min } from 'class-validator';

export class CreateUploadDto {
  @ApiProperty({ example: 'site-plan.pdf', maxLength: 255 })
  @IsString()
  @MaxLength(255)
  name!: string;

  @ApiProperty({ example: 1048576, maximum: 20971520 })
  @IsInt()
  @Min(1)
  @Max(20 * 1024 * 1024)
  size!: number;

  @ApiProperty({ example: 'application/pdf' })
  @IsString()
  @MaxLength(127)
  type!: string;

  @ApiProperty({ enum: UploadPurpose })
  @IsEnum(UploadPurpose)
  purpose!: UploadPurpose;
}
