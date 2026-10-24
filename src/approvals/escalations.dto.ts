import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export class RaiseEscalationDto {
  @IsIn(['operations', 'super_admin']) target!: 'operations' | 'super_admin';
  @IsString() @MinLength(5) @MaxLength(1000) note!: string;
}

export class ResolveEscalationDto {
  @IsString() @MinLength(5) @MaxLength(1000) note!: string;
}
