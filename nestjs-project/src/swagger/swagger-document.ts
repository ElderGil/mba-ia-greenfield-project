import type { INestApplication } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import swaggerConfig from '../config/swagger.config';

function buildSwaggerConfig() {
  return new DocumentBuilder()
    .setTitle('StreamTube API')
    .setDescription('API REST do StreamTube')
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'access-token',
    )
    .build();
}

export function buildSwaggerDocument(app: INestApplication) {
  return SwaggerModule.createDocument(app, buildSwaggerConfig(), {
    extraModels: [ApiErrorEnvelope],
  });
}

export async function setupSwagger(
  app: INestApplication,
  metadata?: Parameters<typeof SwaggerModule.loadPluginMetadata>[0],
): Promise<void> {
  const config = app.get<ConfigType<typeof swaggerConfig>>(swaggerConfig.KEY);
  if (!config.enabled) return;

  if (metadata) await SwaggerModule.loadPluginMetadata(metadata);
  SwaggerModule.setup('api/docs', app, buildSwaggerDocument(app), {
    customSiteTitle: 'StreamTube API Docs',
    swaggerOptions: { persistAuthorization: true },
  });
}
