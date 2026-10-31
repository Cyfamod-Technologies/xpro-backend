import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { REQUEST_STATUSES } from '../domain/statuses';

export const CONVERSATION_DEFAULT_LIMIT = 25;
export const CONVERSATION_MAX_LIMIT = 50;
export const CONVERSATION_SEARCH_MAX_LENGTH = 100;

/** `?status=a` and `?status=a&status=b` both arrive as the same list. */
function toList(value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  return Array.isArray(value) ? (value as unknown[]) : [value];
}

export class ConversationListQueryDto {
  @ApiPropertyOptional({
    enum: REQUEST_STATUSES,
    isArray: true,
    description:
      'Repeatable. Keeps only conversations whose request is in one of these statuses. `meta.statusCounts` ignores it.',
  })
  @IsOptional()
  @Transform(({ value }) => toList(value))
  @IsArray()
  @ArrayMaxSize(REQUEST_STATUSES.length)
  @IsIn(REQUEST_STATUSES, { each: true })
  status?: string[];

  @ApiPropertyOptional({
    maxLength: CONVERSATION_SEARCH_MAX_LENGTH,
    description:
      'Case-insensitive search over request id, title, description, service and sub-service, location (place, LGA and state), customer name and provider business name. Message text is not searched.',
  })
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : (value as unknown),
  )
  @IsString()
  @MaxLength(CONVERSATION_SEARCH_MAX_LENGTH)
  q?: string;

  @ApiPropertyOptional({
    description: 'Opaque marker from `meta.nextCursor` of the previous page.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: CONVERSATION_MAX_LIMIT,
    default: CONVERSATION_DEFAULT_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CONVERSATION_MAX_LIMIT)
  limit: number = CONVERSATION_DEFAULT_LIMIT;
}
