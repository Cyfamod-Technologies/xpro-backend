import { ApiProperty } from '@nestjs/swagger';
import { Allow } from 'class-validator';

export class RequestReleaseDto {
  @ApiProperty({ minLength: 5, maxLength: 500 }) @Allow() note!: string;
  @ApiProperty() @Allow() expectedOwnerId!: string;
}

export class RequestHandoffDto {
  @ApiProperty() @Allow() toStaffId!: string;
  @ApiProperty({ minLength: 5, maxLength: 500 }) @Allow() note!: string;
}

export class RequestReassignDto {
  @ApiProperty() @Allow() staffId!: string;
  @ApiProperty({ minLength: 5, maxLength: 500 }) @Allow() note!: string;
  @ApiProperty() @Allow() expectedOwnerId!: string | null;
}
