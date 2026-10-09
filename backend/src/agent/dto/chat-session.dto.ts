import { IsOptional, IsString } from 'class-validator';

export class CreateSessionDto {
  @IsString()
  @IsOptional()
  title?: string;
}

export class UpdateSessionDto {
  @IsString()
  @IsOptional()
  title?: string;
}
