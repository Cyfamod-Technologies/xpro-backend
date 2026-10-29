import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DateRole, QuestionType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export class CreateServiceDto {
  @ApiPropertyOptional({
    description: 'Parent service; omit for a top-level service',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiProperty({ maxLength: 80 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ example: 'tabler-tools' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  icon?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiresStartDate?: boolean;
}

export class UpdateServiceDto {
  @ApiProperty({ description: 'The version the editor loaded' })
  @IsInt()
  @Min(1)
  version: number;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  icon?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  requiresStartDate?: boolean;
}

export class ReorderServicesDto {
  @ApiProperty({ type: String, nullable: true })
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  parentId: string | null;

  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  ids: string[];
}

export class QuestionOptionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ maxLength: 80 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  label: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class QuestionConfigDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  min?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  max?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  integer?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  exclusiveMinimum?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5000)
  minLength?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5000)
  maxLength?: number;
}

export class CreateQuestionDto {
  @ApiProperty({ maxLength: 120 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  label: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  helpText?: string;

  @ApiProperty({ enum: QuestionType })
  @IsEnum(QuestionType)
  type: QuestionType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional({ type: [QuestionOptionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => QuestionOptionDto)
  options?: QuestionOptionDto[];

  @ApiPropertyOptional({ type: QuestionConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => QuestionConfigDto)
  config?: QuestionConfigDto;

  @ApiPropertyOptional({ enum: DateRole })
  @IsOptional()
  @IsEnum(DateRole)
  dateRole?: DateRole;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  sensitive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  matchesSkill?: boolean;
}

export class UpdateQuestionDto {
  @ApiProperty({ description: 'The version the editor loaded' })
  @IsInt()
  @Min(1)
  version: number;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  label?: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  helpText?: string;

  @ApiPropertyOptional({ enum: QuestionType })
  @IsOptional()
  @IsEnum(QuestionType)
  type?: QuestionType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  required?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ type: [QuestionOptionDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => QuestionOptionDto)
  options?: QuestionOptionDto[];

  @ApiPropertyOptional({ type: QuestionConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => QuestionConfigDto)
  config?: QuestionConfigDto;

  @ApiPropertyOptional({ enum: DateRole, nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsEnum(DateRole)
  dateRole?: DateRole | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  sensitive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  matchesSkill?: boolean;
}

export class ReorderQuestionsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID('all', { each: true })
  ids: string[];
}

export class CatalogSettingsDto {
  @ApiProperty({ minimum: 2, maximum: 10 })
  @IsInt()
  @Min(2)
  @Max(10)
  maxDepth: number;
}
