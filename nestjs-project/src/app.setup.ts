import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { json, type RequestHandler } from 'express';
import { DomainExceptionFilter } from './common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from './common/filters/validation-exception.filter';
import {
  COMPLETE_UPLOAD_JSON_LIMIT,
  COMPLETE_UPLOAD_ROUTE,
} from './videos/videos.constants';

/**
 * Global HTTP setup, shared by main.ts and the e2e suites so tests run the
 * application exactly as it is served. Call it before app.init()/listen().
 */
export function configureApp(app: NestExpressApplication): void {
  // Only complete-upload carries up to 10 000 part ETags (about 550 kB);
  // every other route keeps the default JSON limit (100 kB), which Nest
  // registers on init. The wrapper's name matters: Nest skips its own JSON
  // parser if it finds a middleware named "jsonParser", which would leave
  // every other route unparsed. A body read here is not read again.
  const parseLargeJson = json({ limit: COMPLETE_UPLOAD_JSON_LIMIT });
  const completeUploadJsonParser: RequestHandler = (req, res, next) => {
    // Express mounts app.use() for all methods and on descendant paths.
    if (req.method === 'POST' && req.path === '/') {
      parseLargeJson(req, res, next);
    } else {
      next();
    }
  };
  app.use(COMPLETE_UPLOAD_ROUTE, completeUploadJsonParser);

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
