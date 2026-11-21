import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ApiHttpError {
  @ApiProperty({ example: 401 })
  statusCode: number;

  @ApiProperty({ example: 'Unauthorized' })
  message: string;

  @ApiPropertyOptional()
  error?: string;
}
