import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class AcceptedTermsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  termsVersion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  privacyVersion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  providerAgreementVersion?: string;
}

export class RegisterDto {
  @ApiProperty({ minLength: 1, maxLength: 80 })
  @IsString()
  @Length(1, 80)
  firstName: string;

  @ApiProperty({ minLength: 1, maxLength: 80 })
  @IsString()
  @Length(1, 80)
  lastName: string;

  @ApiProperty({ format: 'email' })
  @IsEmail()
  email: string;

  @ApiProperty({ format: 'password', minLength: 12 })
  @IsString()
  @MinLength(12)
  password: string;

  @ApiProperty({ enum: ['customer', 'provider'] })
  @IsString()
  @Matches(/^(customer|provider)$/)
  role: 'customer' | 'provider';

  @ApiPropertyOptional({
    description:
      'Versions of currently published legal documents accepted by the user, when available.',
    example: { termsVersion: '2026-10-01', privacyVersion: '2026-10-01' },
  })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AcceptedTermsDto)
  acceptedTerms?: AcceptedTermsDto;

  @ApiPropertyOptional()
  @IsOptional()
  @Matches(/^\/(?!\/)/, {
    message: 'returnTo must be an application-relative path',
  })
  returnTo?: string;
}

export class VerifyEmailTokenDto {
  @ApiProperty()
  @IsString()
  token: string;
}

export class SignupDto {
  @ApiProperty({ type: String, example: 'Alex' })
  @IsString()
  firstName: string;

  @ApiProperty({ type: String, example: 'Johnson' })
  @IsString()
  lastName: string;

  @ApiProperty({ type: String, format: 'email' })
  @IsEmail()
  email: string;

  @ApiProperty({ type: String, format: 'password', minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;
}

export class VerifyEmailDto {
  @ApiProperty({ type: String, format: 'email' })
  @IsEmail()
  email: string;

  @ApiProperty({ type: String, example: '123456' })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Verification code must be 6 digits' })
  code: string;
}

export class ResendVerificationDto {
  @ApiProperty({ type: String, format: 'email' })
  @IsEmail()
  email: string;
}

export class LoginDto {
  @ApiProperty({ type: String, format: 'email' })
  @IsEmail()
  email: string;

  @ApiProperty({ type: String, format: 'password' })
  @IsString()
  password: string;

  @ApiPropertyOptional({
    type: String,
    description: 'TOTP code — required when MFA is enabled',
  })
  @IsOptional()
  @IsString()
  mfaCode?: string;
}

export class ForgotPasswordDto {
  @ApiProperty({ type: String, format: 'email' })
  @IsEmail()
  email: string;
}

export class ResetPasswordDto {
  @ApiProperty({ type: String })
  @IsString()
  token: string;

  @ApiProperty({ type: String, format: 'password', minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;
}

export class UpdateMeDto {
  @ApiPropertyOptional({ type: String, example: 'Alex' })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional({ type: String, example: 'Johnson' })
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiPropertyOptional({
    type: String,
    example: 'https://cdn.xpro.com/avatars/alex.png',
  })
  @IsOptional()
  @IsUrl()
  avatarUrl?: string;

  @ApiPropertyOptional({ type: String, example: 'en' })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({ type: String, example: 'America/New_York' })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional({ description: 'Personal notification preferences' })
  @IsOptional()
  @IsObject()
  notificationPreferences?: Record<string, unknown>;
}

export class ChangePasswordDto {
  @ApiProperty({ type: String, format: 'password' })
  @IsString()
  currentPassword: string;

  @ApiProperty({ type: String, format: 'password', minLength: 8 })
  @IsString()
  @MinLength(8)
  password: string;
}

export class ConfirmMfaDto {
  @ApiProperty({
    type: String,
    description: '6-digit TOTP code from authenticator app',
  })
  @IsString()
  @Matches(/^\d{6}$/, { message: 'MFA code must be 6 digits' })
  code: string;
}

export class DisableMfaDto {
  @ApiProperty({ type: String, format: 'password' })
  @IsString()
  password: string;

  @ApiPropertyOptional({
    type: String,
    description: '6-digit TOTP code — required if MFA is currently enabled',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'MFA code must be 6 digits' })
  code?: string;
}

export class ReauthenticateDto {
  @ApiProperty({ type: String, format: 'password' })
  @IsString()
  password: string;

  @ApiPropertyOptional({
    type: String,
    description: '6-digit TOTP code — required if MFA is currently enabled',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'MFA code must be 6 digits' })
  code?: string;
}
