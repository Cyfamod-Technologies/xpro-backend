import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
  ValidateIf,
} from 'class-validator';

export class V1AttachmentDto {
  @ApiProperty()
  @IsString()
  id!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  size?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(150)
  type?: string;
}

export class V1CreateRequestDto {
  @ApiPropertyOptional({
    description:
      'V1 service id; use serviceId for the existing request contract',
  })
  @IsOptional()
  @IsString()
  service?: string;

  @ApiPropertyOptional({ description: 'Existing request API service id' })
  @IsOptional()
  @IsString()
  serviceId?: string;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(120)
  title!: string;

  @ApiProperty()
  @IsString()
  @MinLength(20)
  @MaxLength(5000)
  description!: string;

  @ApiPropertyOptional({
    description:
      'V1 serviceable location id; use locationId for the existing request contract',
  })
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional({
    description: 'Existing request API serviceable location id',
  })
  @IsOptional()
  @IsString()
  locationId?: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  address!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(30)
  phone!: string;

  @ApiPropertyOptional({
    enum: ['phone', 'whatsapp', 'email', 'both'],
    default: 'phone',
  })
  @IsOptional()
  @IsIn(['phone', 'whatsapp', 'email', 'both'])
  contactMethod?: 'phone' | 'whatsapp' | 'email' | 'both';

  @ApiPropertyOptional({
    description: 'V1 amount in kobo; alternatively use budget in naira',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  budgetKobo?: number;

  @ApiPropertyOptional({ description: 'Existing request API amount in naira' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Math.floor(Number.MAX_SAFE_INTEGER / 100))
  budget?: number;

  @ApiPropertyOptional()
  @ValidateIf((_dto, value) => value !== undefined && value !== '')
  @IsDateString()
  preferredDate?: string;

  @ApiPropertyOptional({
    description: 'Existing request API preferred start date',
  })
  @ValidateIf((_dto, value) => value !== undefined && value !== '')
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ type: [V1AttachmentDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => V1AttachmentDto)
  attachments?: V1AttachmentDto[];

  @ApiPropertyOptional({
    description: 'Existing request API service question answers',
  })
  @IsOptional()
  @IsObject()
  answers?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Legacy service question details' })
  @IsOptional()
  @IsObject()
  details?: Record<string, unknown>;
}

export class V1ListRequestsQueryDto {
  @ApiPropertyOptional({
    enum: ['submitted', 'approved', 'denied', 'cancelled'],
  })
  @IsOptional()
  @IsIn(['submitted', 'approved', 'denied', 'cancelled'])
  status?: 'submitted' | 'approved' | 'denied' | 'cancelled';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  assignee?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  service?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  itemsPerPage = 10;
}

export class V1AssignStaffDto {
  @ApiProperty()
  @IsString()
  staffId!: string;

  @ApiProperty({ nullable: true })
  @IsOptional()
  @IsString()
  expectedOwnerId!: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class V1ApproveDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

export class V1DenyDto {
  @ApiProperty()
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason!: string;
}

export class V1ReplaceProviderDto {
  @ApiProperty()
  @IsString()
  providerId!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  priceKobo?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  date?: string;
}

export class V1CounterDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  amountKobo!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  date?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class V1SendMessageDto {
  @ApiProperty({ enum: ['customer'] })
  @IsIn(['customer'])
  channel!: 'customer';

  @ApiProperty({ enum: ['text', 'counter'] })
  @IsIn(['text', 'counter'])
  kind!: 'text' | 'counter';

  @ApiProperty()
  @IsString()
  @MaxLength(2000)
  text!: string;

  @ApiProperty({ type: [V1AttachmentDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => V1AttachmentDto)
  attachments!: V1AttachmentDto[];

  @ApiPropertyOptional({ type: V1CounterDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => V1CounterDto)
  counter?: V1CounterDto;
}
