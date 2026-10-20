import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StaffRole, StaffStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsObject,
  IsString,
  Length,
  Max,
  Matches,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class InviteStaffDto {
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

  @ApiProperty({ enum: StaffRole, isArray: true })
  @IsArray()
  @IsEnum(StaffRole, { each: true })
  roles: StaffRole[];
}

export class ChangeStaffRolesDto {
  @ApiProperty({ enum: StaffRole, isArray: true })
  @IsArray()
  @IsEnum(StaffRole, { each: true })
  roles: StaffRole[];

  @ApiProperty()
  @IsString()
  @Length(5, 500)
  reason: string;
}

export class RenameStaffDto {
  @ApiProperty({ minLength: 1, maxLength: 80 })
  @IsString()
  @Length(1, 80)
  firstName: string;

  @ApiProperty({ minLength: 1, maxLength: 80 })
  @IsString()
  @Length(1, 80)
  lastName: string;

  @ApiProperty()
  @IsString()
  @Length(5, 500)
  reason: string;
}

export class StaffReasonDto {
  @ApiProperty()
  @IsString()
  @Length(5, 500)
  reason: string;
}

export class ReactivateStaffDto extends StaffReasonDto {
  @ApiProperty({ enum: StaffRole, isArray: true })
  @IsArray()
  @IsEnum(StaffRole, { each: true })
  roles: StaffRole[];

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  resetMfa = false;
}

export class StaffConflictDeclarationDto {
  @ApiProperty()
  @IsBoolean()
  hasLinkedCustomerAccount: boolean;

  @ApiPropertyOptional({ format: 'email' })
  @IsOptional()
  @IsEmail()
  linkedCustomerEmail?: string;

  @ApiProperty({ minLength: 10, maxLength: 1000 })
  @IsString()
  @Length(10, 1000)
  statement: string;
}

export class AcceptStaffInviteDto {
  @ApiProperty()
  @IsString()
  token: string;

  @ApiProperty({ minLength: 12 })
  @IsString()
  @MinLength(12)
  password: string;

  @ApiProperty()
  @IsString()
  policyVersion: string;

  @ApiProperty({ type: () => StaffConflictDeclarationDto })
  @IsObject()
  @ValidateNested()
  @Type(() => StaffConflictDeclarationDto)
  conflictDeclaration: StaffConflictDeclarationDto;
}

export class VerifyStaffMfaDto {
  @ApiProperty()
  @IsString()
  enrollmentToken: string;

  @ApiProperty({ pattern: '^\\d{6}$' })
  @IsString()
  @Matches(/^\d{6}$/)
  code: string;
}

export class ListStaffQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  q?: string;

  @ApiPropertyOptional({ enum: StaffStatus })
  @IsOptional()
  @IsEnum(StaffStatus)
  status?: StaffStatus;

  @ApiPropertyOptional({ enum: StaffRole })
  @IsOptional()
  @IsEnum(StaffRole)
  role?: StaffRole;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 25, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 25;
}
