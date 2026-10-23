import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class ListNotificationsQueryDto {
  @ApiPropertyOptional({ description: 'Only unread notifications.' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === '' || value === 'true' || value === '1' || value === true
      ? true
      : value === 'false' || value === '0' || value === false
        ? false
        : value,
  )
  @IsBoolean()
  unread?: boolean;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  itemsPerPage = 20;
}

export class MarkNotificationsReadDto {
  @ApiPropertyOptional({
    description: 'Omit to mark every unread notification as read.',
  })
  @IsOptional()
  @IsUUID()
  notificationId?: string;
}
