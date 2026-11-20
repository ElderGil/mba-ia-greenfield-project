import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { MAX_MULTIPART_PARTS } from '../videos.constants';

export class UploadPartEtagDto {
  @ApiProperty({ example: 1, minimum: 1, maximum: MAX_MULTIPART_PARTS })
  @IsInt()
  @Min(1)
  @Max(MAX_MULTIPART_PARTS)
  partNumber: number;

  // S3 ETags are a quoted MD5, plus "-N" for multipart: well under 128.
  @ApiProperty({
    example: '"d41d8cd98f00b204e9800998ecf8427e"',
    maxLength: 128,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  etag: string;
}

export class CompleteUploadDto {
  @ApiProperty({ type: [UploadPartEtagDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_MULTIPART_PARTS)
  @ValidateNested({ each: true })
  @Type(() => UploadPartEtagDto)
  parts: UploadPartEtagDto[];
}
