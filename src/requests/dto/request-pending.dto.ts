import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PendingRequestResponseDto {
  @ApiProperty({
    description:
      'True when the account owns a request that is not closed, cancelled or rejected (openCount > 0).',
  })
  hasPending!: boolean;

  @ApiPropertyOptional({
    example: 'XPR-00042',
    description: 'The most recent open request.',
  })
  requestId?: string;

  @ApiProperty({
    example: 1,
    description:
      'Requests that are not closed, cancelled or rejected. A request being cancelled still counts.',
  })
  openCount!: number;

  @ApiProperty({
    example: 3,
    description:
      "The most open requests the account may have: the staff-set limit for this customer, else the platform's request.maxOpenPerCustomer.",
  })
  limit!: number;

  @ApiProperty({
    example: 2,
    description:
      'limit minus openCount, never below 0. A submission creating more requests than this is refused with OPEN_REQUEST_LIMIT.',
  })
  remaining!: number;
}
