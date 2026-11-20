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

  @ApiProperty({ example: '"d41d8cd98f00b204e9800998ecf8427e"' })
  @IsString()
  @IsNotEmpty()
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
