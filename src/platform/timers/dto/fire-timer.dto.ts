import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class FireTimerDto {
  @ApiProperty({
    description:
      'Request reference: an XPR number (XPR-00042) or the request uuid',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  requestRef!: string;

  @ApiProperty({ example: 'T1.expire' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  kind!: string;
}
