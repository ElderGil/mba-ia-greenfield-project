import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { setupSwagger } from '../src/swagger/swagger-document';

async function createApp(): Promise<INestApplication<App>> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication<NestExpressApplication>();
  configureApp(app);

  await setupSwagger(app);
  await app.init();
  return app;
}

describe('Swagger endpoints (e2e)', () => {
  const originalSwaggerEnabled = process.env.SWAGGER_ENABLED;

  afterAll(() => {
    if (originalSwaggerEnabled === undefined) {
      delete process.env.SWAGGER_ENABLED;
    } else {
      process.env.SWAGGER_ENABLED = originalSwaggerEnabled;
    }
  });

  describe('when SWAGGER_ENABLED=true', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      process.env.SWAGGER_ENABLED = 'true';
      app = await createApp();
    });

    afterAll(async () => {
      await app.close();
    });

    it('GET /api/docs returns 200 with HTML containing the custom title', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/docs')
        .expect(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toContain('StreamTube API Docs');
    });

    it('GET /api/docs-json returns 200 with valid OpenAPI JSON', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/docs-json')
        .expect(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      const doc = res.body as Record<string, unknown>;
      expect((doc.info as Record<string, unknown>).title).toBe(
        'StreamTube API',
      );
      expect(
        (doc.components as Record<string, unknown>)?.securitySchemes as Record<
          string,
          unknown
        >,
      ).toMatchObject({
        'access-token': { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      });
      expect(doc.components).toHaveProperty(
        'schemas.ApiErrorEnvelope.type',
        'object',
      );
    });

    it('GET /api/docs-yaml returns 200 with YAML content', async () => {
      const res = await request(app.getHttpServer())
        .get('/api/docs-yaml')
        .expect(200);
      expect(res.headers['content-type']).toMatch(/yaml/);
    });
  });

  describe('when SWAGGER_ENABLED is disabled', () => {
    let app: INestApplication<App>;

    beforeAll(async () => {
      process.env.SWAGGER_ENABLED = 'false';
      app = await createApp();
    });

    afterAll(async () => {
      await app.close();
    });

    it('GET /api/docs returns 404', async () => {
      await request(app.getHttpServer()).get('/api/docs').expect(404);
    });

    it('GET /api/docs-json returns 404', async () => {
      await request(app.getHttpServer()).get('/api/docs-json').expect(404);
    });

    it('GET /api/docs-yaml returns 404', async () => {
      await request(app.getHttpServer()).get('/api/docs-yaml').expect(404);
    });
  });
});
