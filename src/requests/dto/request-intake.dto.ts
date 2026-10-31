import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { Allow } from 'class-validator';

export class RequestAttachmentRefDto {
  @ApiProperty()
  @Allow()
  id!: string;
}

export class RequestIntakeDto {
  @ApiProperty() @Allow() title!: string;
  @ApiPropertyOptional({ description: 'The leaf service the customer chose' })
  @Allow()
  serviceId?: string;
  @ApiPropertyOptional({ description: 'Legacy top-level service name' })
  @Allow()
  service?: string;
  @ApiProperty({
    description: 'A served LGA or area, chosen from GET /locations',
  })
  @Allow()
  locationId!: string;
  @ApiProperty() @Allow() address!: string;
  @ApiProperty() @Allow() phone!: string;
  @ApiPropertyOptional({ enum: ['email', 'phone', 'both'], default: 'phone' })
  @Allow()
  contactMethod?: 'email' | 'phone' | 'both';
  @ApiProperty() @Allow() description!: string;
  @ApiProperty({ minimum: 0 }) @Allow() budget!: number;
  @ApiPropertyOptional({ description: 'ISO calendar date in WAT' })
  @Allow()
  startDate?: string;
  @ApiPropertyOptional({
    description:
      'Answers by question id: "Yes"/"No", an option id, an array of option ids, text, a number or an ISO date',
  })
  @Allow()
  answers?: Record<string, unknown>;
  @ApiPropertyOptional({ description: 'Legacy answers by question key' })
  @Allow()
  details?: Record<string, unknown>;
  @ApiProperty({ type: [RequestAttachmentRefDto] })
  @Type(() => RequestAttachmentRefDto)
  @Allow()
  attachments!: RequestAttachmentRefDto[];
  @ApiPropertyOptional() @Allow() preferredProviderId?: string;
  @ApiPropertyOptional() @Allow() providerId?: string;
}

export class RequestUpdateDto {
  @ApiPropertyOptional() @Allow() title?: string;
  @ApiPropertyOptional() @Allow() serviceId?: string;
  @ApiPropertyOptional() @Allow() service?: string;
  @ApiPropertyOptional() @Allow() locationId?: string;
  @ApiPropertyOptional() @Allow() address?: string;
  @ApiPropertyOptional() @Allow() phone?: string;
  @ApiPropertyOptional({ enum: ['email', 'phone', 'both'] })
  @Allow()
  contactMethod?: 'email' | 'phone' | 'both';
  @ApiPropertyOptional() @Allow() description?: string;
  @ApiPropertyOptional({ minimum: 0 }) @Allow() budget?: number;
  @ApiPropertyOptional() @Allow() startDate?: string;
  @ApiPropertyOptional() @Allow() answers?: Record<string, unknown>;
  @ApiPropertyOptional() @Allow() details?: Record<string, unknown>;
  @ApiPropertyOptional({ type: [RequestAttachmentRefDto] })
  @Type(() => RequestAttachmentRefDto)
  @Allow()
  attachments?: RequestAttachmentRefDto[];
  @ApiPropertyOptional() @Allow() note?: string;
  @ApiPropertyOptional() @Allow() preferredProviderId?: string;
  @ApiPropertyOptional() @Allow() providerId?: string;
}

export class RequestClarifyDto {
  @ApiProperty({ minLength: 5, maxLength: 1000 }) @Allow() question!: string;
}

export class RequestReviewDto {
  @ApiProperty({ minLength: 20, maxLength: 1000 }) @Allow() offerBrief!: string;
  @ApiPropertyOptional({
    type: 'object',
    properties: {
      description: { type: 'boolean' },
      attachmentIds: { type: 'array', items: { type: 'string' } },
    },
  })
  @Allow()
  shareOnConfirm?: { description: boolean; attachmentIds: string[] };
  @ApiPropertyOptional() @Allow() contactCheck?: boolean;
}

export class RequestRejectDto {
  @ApiProperty({ minLength: 5, maxLength: 1000 }) @Allow() reason!: string;
}

export class RequestFreeCancelDto {
  @ApiProperty({ minLength: 1, maxLength: 1000 }) @Allow() note!: string;
}
