import { ApiProperty } from '@nestjs/swagger';
import {
  IsInt,
  IsNotEmpty,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class InitiateUploadDto {
  @ApiProperty({ example: 'My Awesome Video', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(255)
  title: string;

  @ApiProperty({ example: 'recording.mp4', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  @ApiProperty({
    example: 'video/mp4',
    enum: ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'],
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  mimeType: string;

  @ApiProperty({
    example: 104857600,
    description: 'File size in bytes (up to 10 GiB = 10737418240 bytes)',
  })
  @IsInt()
  @IsPositive()
  sizeBytes: number;
}
