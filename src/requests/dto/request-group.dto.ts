import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { Allow } from 'class-validator';
import { RequestAttachmentRefDto } from './request-intake.dto';

/** One service card of the request form. Shape only: the domain validators own the messages (06 §11.1). */
export class RequestGroupServiceDto {
  @ApiProperty({ description: 'The catalogue leaf the customer chose' })
  @Allow()
  serviceId!: string;
  @ApiProperty({
    description: 'Answers by question id, as for POST /requests',
  })
  @Allow()
  answers!: Record<string, unknown>;
  @ApiProperty() @Allow() description!: string;
  @ApiProperty({ minimum: 0 }) @Allow() budget!: number;
  @ApiPropertyOptional({ description: 'ISO calendar date in WAT' })
  @Allow()
  startDate?: string;
  @ApiPropertyOptional({
    type: [RequestAttachmentRefDto],
    description: 'Files for this service only; added to the shared files',
  })
  @Type(() => RequestAttachmentRefDto)
  @Allow()
  attachments?: RequestAttachmentRefDto[];
  @ApiPropertyOptional() @Allow() preferredProviderId?: string;
  @ApiPropertyOptional() @Allow() providerId?: string;
}

export class RequestGroupCreateDto {
  @ApiProperty({ description: 'The project title, shared by every service' })
  @Allow()
  title!: string;
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
  /** Not part of the documented shape (MS-8): accepted so the group check can refuse it with its own message. */
  @Allow()
  attachments?: unknown;
  @ApiProperty({ type: [RequestGroupServiceDto] })
  @Type(() => RequestGroupServiceDto)
  @Allow()
  services!: RequestGroupServiceDto[];
  @ApiPropertyOptional() @Allow() preferredProviderId?: string;
  @ApiPropertyOptional() @Allow() providerId?: string;
}
