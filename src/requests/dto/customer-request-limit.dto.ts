import { ApiProperty } from '@nestjs/swagger';
import { Allow } from 'class-validator';

/** Shape only: the service owns the messages (04 §11.2, MS-7). */
export class SetCustomerRequestLimitDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 1,
    maximum: 50,
    description:
      'The most open requests this customer may have, or null to use the platform setting request.maxOpenPerCustomer',
  })
  @Allow()
  limit!: number | null;

  @ApiProperty({
    minLength: 5,
    maxLength: 500,
    description: 'Why the limit changes. Kept in the audit trail.',
  })
  @Allow()
  note!: string;
}

export class CustomerRequestLimitResponseDto {
  @ApiProperty() userId!: string;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'The staff-set limit, or null when none is set',
  })
  override!: number | null;
  @ApiProperty({
    description: 'The limit in force: the override, else the platform setting',
  })
  effective!: number;
  @ApiProperty({
    description: 'Requests that are not closed, cancelled or rejected',
  })
  open!: number;
}
