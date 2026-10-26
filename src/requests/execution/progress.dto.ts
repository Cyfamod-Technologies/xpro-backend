import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { AttachmentRefDto } from '../dto/attachment-ref.dto';

// Length and presence rules carry the spec messages, so the progress rules check them (Plan C.7).
export class AddProgressDto {
  @ApiProperty({ enum: ['in_progress', 'blocked', 'completion_pending'] })
  @IsIn(['in_progress', 'blocked', 'completion_pending'])
  status!: 'in_progress' | 'blocked' | 'completion_pending';

  @ApiProperty() @IsString() note!: string;

  @ApiPropertyOptional({ type: [AttachmentRefDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => AttachmentRefDto)
  attachments: AttachmentRefDto[] = [];

  @ApiPropertyOptional() @IsOptional() @IsString() issueId?: string;
}

export class ReviewProgressDto {
  @IsIn([true, false]) approve!: boolean;
  @IsOptional() @IsString() @MaxLength(1000) note?: string;
}

export class AddProgressOnBehalfDto {
  @ApiProperty({ enum: ['in_progress', 'blocked', 'completion_pending'] })
  @IsIn(['in_progress', 'blocked', 'completion_pending'])
  status!: 'in_progress' | 'blocked' | 'completion_pending';

  @ApiProperty() @IsString() note!: string;

  @ApiProperty() @IsString() reportedVia!: string;

  @ApiPropertyOptional({ type: [AttachmentRefDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => AttachmentRefDto)
  attachments: AttachmentRefDto[] = [];

  @ApiPropertyOptional() @IsOptional() @IsString() issueId?: string;
}
