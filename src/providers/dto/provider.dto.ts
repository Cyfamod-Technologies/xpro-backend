import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProviderUploadPurpose } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsEnum,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class ProviderAttachmentDto {
  @ApiProperty()
  @IsString()
  id: string;

  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(20 * 1024 * 1024)
  size: number;

  @ApiProperty()
  @IsString()
  type: string;
}

export class CreateProviderUploadDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(180)
  name: string;

  @ApiProperty()
  @IsString()
  type: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(20 * 1024 * 1024)
  size: number;

  @ApiProperty({ enum: ProviderUploadPurpose })
  @IsEnum(ProviderUploadPurpose)
  purpose: ProviderUploadPurpose;
}

export class ProviderProfileSubmissionDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  phone: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  trade: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  city?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  cityId?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Deprecated: send serviceIds.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  services?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'Ids of the top-level catalog services the provider offers.',
  })
  @IsOptional()
  @IsArray()
  @IsUUID('all', { each: true })
  serviceIds?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  serviceAreas?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  serviceAreaIds?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  businessName?: string;

  @ApiPropertyOptional({ description: 'Deprecated: send skillIds.' })
  @IsOptional()
  @IsObject()
  skills?: Record<string, string[]>;

  @ApiPropertyOptional({
    description:
      'Top-level service id to the skill option ids and skill-leaf ids chosen under it.',
  })
  @IsOptional()
  @IsObject()
  skillIds?: Record<string, string[]>;

  @ApiProperty({ minimum: 1, maximum: 20 })
  @IsInt()
  @Min(1)
  @Max(20)
  capacity: number;

  @ApiProperty()
  @IsObject()
  workingHours: Record<string, { start: string; end: string } | null>;

  @ApiProperty()
  @IsNumber()
  @Min(0)
  experience: number;

  @ApiProperty()
  @IsString()
  @MinLength(20)
  @MaxLength(2000)
  bio: string;

  @ApiProperty({ type: [ProviderAttachmentDto] })
  @IsArray()
  @Type(() => ProviderAttachmentDto)
  documents: ProviderAttachmentDto[];

  @ApiProperty()
  @Type(() => ProviderAttachmentDto)
  photo: ProviderAttachmentDto;

  @ApiPropertyOptional({ type: [ProviderAttachmentDto] })
  @IsOptional()
  @IsArray()
  @Type(() => ProviderAttachmentDto)
  portfolio?: ProviderAttachmentDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  bankCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(10)
  accountNumber?: string;
}

export class ProviderBankUpdateDto {
  @ApiProperty()
  @IsString()
  bankCode: string;

  @ApiProperty()
  @IsString()
  @MinLength(10)
  @MaxLength(10)
  accountNumber: string;
}

export class ProviderBankResolveDto extends ProviderBankUpdateDto {}

export class ProviderAvailabilityDto {
  @ApiProperty()
  @IsBoolean()
  available: boolean;
}

export class ProviderCalendarDto {
  @ApiProperty()
  @IsObject()
  workingHours: Record<string, { start: string; end: string } | null>;

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  timeOff?: { id?: string; from: string; to: string; note?: string }[];
}

export class ProviderReviewDto {
  @ApiProperty({ enum: ['approved', 'changes_requested', 'rejected'] })
  @IsString()
  decision: 'approved' | 'changes_requested' | 'rejected';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  expectedVersion: number;
}

export class ProviderBankReviewDto {
  @ApiProperty()
  @IsBoolean()
  approve: boolean;

  @ApiProperty()
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  note: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  expectedVersion: number;
}

export class ProviderChangesReviewDto {
  @ApiProperty()
  @IsBoolean()
  approve: boolean;

  @ApiProperty()
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  note: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  expectedVersion: number;
}

export class ProviderListQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsIn([
    'draft',
    'pending',
    'changes_requested',
    'rejected',
    'approved',
    'delisted',
  ])
  verification?: string;

  @ApiPropertyOptional({
    description: 'Search provider name, email, trade or area.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  q?: string;

  @ApiPropertyOptional({ enum: ['pending', 'verified', 'rejected', 'none'] })
  @IsOptional()
  @IsIn(['pending', 'verified', 'rejected', 'none'])
  bankReview?: 'pending' | 'verified' | 'rejected' | 'none';

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;
}

export class ProviderReliabilityReviewDto {
  @ApiProperty({ enum: ['clear', 'restrict'] })
  @IsIn(['clear', 'restrict'])
  decision: 'clear' | 'restrict';

  @ApiProperty({ minLength: 5, maxLength: 1000 })
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  note: string;
}

export class ProviderStandingDto {
  @ApiProperty({ minLength: 5, maxLength: 1000 })
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason: string;

  @ApiProperty()
  @IsInt()
  @Min(1)
  expectedVersion: number;
}

export class ProviderRevealDto {
  @ApiProperty({ minLength: 5, maxLength: 500 })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}
