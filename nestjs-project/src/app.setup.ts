import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from './common/filters/validation-exception.filter';
import { COMPLETE_UPLOAD_JSON_LIMIT } from './videos/videos.constants';

/**
 * Global HTTP setup, shared by main.ts and the e2e suites so tests run the
 * application exactly as it is served. Call it before app.init()/listen().
 */
export function configureApp(app: NestExpressApplication): void {
  // A complete request may list MAX_MULTIPART_PARTS (10 000) part ETags,
  // about 550 kB of JSON; the Express default (100 kB) would answer 413.
  app.useBodyParser('json', { limit: COMPLETE_UPLOAD_JSON_LIMIT });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
}
