import { Transform } from 'class-transformer';
import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

const NormalizeEmail = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value));

export class LoginDto {
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  password!: string;
}

export class RegisterDto {
  @NormalizeEmail()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(15)
  @MaxLength(128)
  password!: string;
}
