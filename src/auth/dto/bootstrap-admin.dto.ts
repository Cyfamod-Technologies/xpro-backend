import { IsString, Length } from 'class-validator';

export class BootstrapAdminDto {
  @IsString()
  @Length(1, 80)
  firstName!: string;

  @IsString()
  @Length(1, 80)
  lastName!: string;

  @IsString()
  @Length(16, 128)
  password!: string;
}
