import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';

/** `{ id }` of a ready upload; the service attaches it to the new record. */
export class AttachmentRefDto {
  @ApiProperty()
  @IsString()
  id!: string;
}
