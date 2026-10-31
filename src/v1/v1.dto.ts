import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
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
  @ApiProperty()
  @IsString()
  service!: string;

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

  @ApiProperty()
  @IsString()
  location!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  address!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(30)
  phone!: string;

  @ApiProperty({ enum: ['phone', 'whatsapp', 'email'] })
  @IsIn(['phone', 'whatsapp', 'email'])
  contactMethod!: 'phone' | 'whatsapp' | 'email';

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(Number.MAX_SAFE_INTEGER)
  budgetKobo!: number;

  @ApiProperty()
  @IsString()
  @IsOptional()
  preferredDate!: string;

  @ApiProperty({ type: [V1AttachmentDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => V1AttachmentDto)
  attachments!: V1AttachmentDto[];
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
