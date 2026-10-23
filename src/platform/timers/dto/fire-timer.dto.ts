import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class FireTimerDto {
  @ApiProperty({
    description: 'Request id; the XPR number once requests exist',
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
