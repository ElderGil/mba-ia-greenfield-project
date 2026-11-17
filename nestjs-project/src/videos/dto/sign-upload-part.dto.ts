import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Max, Min } from 'class-validator';
import { MAX_MULTIPART_PARTS } from '../videos.constants';

export class SignUploadPartDto {
  @ApiProperty({ example: 1, minimum: 1, maximum: MAX_MULTIPART_PARTS })
  @IsInt()
  @Min(1)
  @Max(MAX_MULTIPART_PARTS)
  partNumber: number;
}
