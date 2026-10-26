import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, MaxLength } from 'class-validator';

// The 5-character minimum is checked by the request.escalate / request.escalation.resolve guards so the spec's messages reach the client (plan C.7).
export class RaiseEscalationDto {
  @ApiProperty({ enum: ['operations', 'super_admin'] })
  @IsIn(['operations', 'super_admin'])
  to!: 'operations' | 'super_admin';

  @ApiProperty() @IsString() @MaxLength(1000) note!: string;
}

export class ResolveEscalationDto {
  @ApiProperty() @IsString() @MaxLength(1000) note!: string;
}
