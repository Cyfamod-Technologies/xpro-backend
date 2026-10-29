import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PendingRequestResponseDto {
  @ApiProperty({
    description:
      'True when the account owns a request that is not closed, cancelled or rejected.',
  })
  hasPending!: boolean;

  @ApiPropertyOptional({
    example: 'XPR-00042',
    description: 'The most recent open request.',
  })
  requestId?: string;
}
