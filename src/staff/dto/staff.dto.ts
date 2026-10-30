import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { StaffRole, StaffStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsIn,
  IsISO8601,
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

export class OwnersQueryDto {
  @ApiPropertyOptional({ description: 'Leave this member out of the picker.' })
  @IsOptional()
  @IsString()
  exclude?: string;
}

export class OwnedRequestMoveDto {
  @ApiProperty()
  @IsString()
  requestId: string;

  @ApiProperty({ description: 'A staff member id, or "queue".' })
  @IsString()
  to: string;
}

/** Where a member's open requests go: everything to one place, or one destination per request. */
export class OwnedRequestsDto {
  @ApiPropertyOptional({ description: 'A staff member id, or "queue".' })
  @IsOptional()
  @IsString()
  all?: string;

  @ApiPropertyOptional({ type: () => [OwnedRequestMoveDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => OwnedRequestMoveDto)
  items?: OwnedRequestMoveDto[];
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

  @ApiPropertyOptional({ type: () => OwnedRequestsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OwnedRequestsDto)
  ownedRequests?: OwnedRequestsDto;
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

export class SuspendStaffDto extends StaffReasonDto {
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  securityIncident = false;

  @ApiPropertyOptional({ type: () => OwnedRequestsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OwnedRequestsDto)
  ownedRequests?: OwnedRequestsDto;
}

export class DeactivateStaffDto extends StaffReasonDto {
  @ApiPropertyOptional({ type: () => OwnedRequestsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OwnedRequestsDto)
  ownedRequests?: OwnedRequestsDto;
}

export const IDENTITY_CHECKS = [
  'in_person',
  'video_call',
  'phone_callback',
] as const;
export type IdentityCheck = (typeof IDENTITY_CHECKS)[number];

export class ResetStaffMfaDto extends StaffReasonDto {
  @ApiProperty({ enum: IDENTITY_CHECKS })
  @IsIn([...IDENTITY_CHECKS])
  identityCheck: IdentityCheck;
}

export class SetStaffLeaveDto {
  @ApiProperty({ example: '2026-11-02', description: 'WAT calendar date' })
  @IsISO8601({ strict: true })
  from: string;

  @ApiProperty({ example: '2026-11-12', description: 'WAT calendar date' })
  @IsISO8601({ strict: true })
  to: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  delegateId?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @Length(0, 500)
  note?: string;
}

export class StaffHistoryQueryDto {
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

  @ApiPropertyOptional({
    enum: ['current', 'former'],
    description:
      'current = invited, active, suspended; former = deactivated, revoked. Ignored when status is set.',
  })
  @IsOptional()
  @IsIn(['current', 'former'])
  group?: 'current' | 'former';

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
