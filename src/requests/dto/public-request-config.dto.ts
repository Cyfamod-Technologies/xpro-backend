import { ApiProperty } from '@nestjs/swagger';

export class PublicRequestConfigDto {
  @ApiProperty({ example: 5, minimum: 1, maximum: 10 })
  maxServicesPerSubmission!: number;
}
