import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class StartPhoneVerificationDto {
  @ApiProperty({ example: '+2348031234567' })
  @IsString()
  @MaxLength(40)
  phone!: string;
}

export class ConfirmPhoneVerificationDto {
  @ApiProperty()
  @IsUUID()
  verificationId!: string;

  @ApiProperty({ description: 'Six-digit code received by SMS' })
  @Matches(/^\d{6}$/, { message: 'Enter the six-digit code.' })
  code!: string;
}
