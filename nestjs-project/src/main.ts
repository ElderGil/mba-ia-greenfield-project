import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { setupSwagger } from './swagger/swagger-document';
import swaggerMetadata from './metadata.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  const configService = app.get(ConfigService);
  const port = configService.get<number>('app.port') ?? 3000;

  await setupSwagger(app, swaggerMetadata);

  await app.listen(port);
}
void bootstrap();
