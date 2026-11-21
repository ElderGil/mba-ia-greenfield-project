import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger/dist/interfaces/open-api-spec.interface';
import { Test } from '@nestjs/testing';
import {
  VideoOwnerResponseDto,
  VideoPublicResponseDto,
} from './video-response.dto';

describe('Video response DTOs (OpenAPI schema)', () => {
  let app: INestApplication;
  let schemas: Record<string, SchemaObject>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({}).compile();
    app = moduleRef.createNestApplication();
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
      { extraModels: [VideoOwnerResponseDto, VideoPublicResponseDto] },
    );
    schemas = document.components!.schemas as Record<string, SchemaObject>;
  });

  afterAll(async () => {
    await app.close();
  });

  // Keys are always present in the JSON, with null until the worker fills them.
  const nullableFields: [string, string, string][] = [
    ['VideoOwnerResponseDto', 'durationSeconds', 'number'],
    ['VideoOwnerResponseDto', 'width', 'integer'],
    ['VideoOwnerResponseDto', 'height', 'integer'],
    ['VideoOwnerResponseDto', 'codec', 'string'],
    ['VideoOwnerResponseDto', 'thumbnailUrl', 'string'],
    ['VideoOwnerResponseDto', 'processingError', 'string'],
    ['VideoPublicResponseDto', 'durationSeconds', 'number'],
    ['VideoPublicResponseDto', 'width', 'integer'],
    ['VideoPublicResponseDto', 'height', 'integer'],
    ['VideoPublicResponseDto', 'codec', 'string'],
  ];

  it.each(nullableFields)(
    'should declare %s.%s as a required, nullable %s',
    (dto, field, type) => {
      const schema = schemas[dto];
      expect(schema.properties?.[field]).toMatchObject({
        type,
        nullable: true,
      });
      expect(schema.required).toContain(field);
    },
  );

  it.each(['VideoOwnerResponseDto', 'VideoPublicResponseDto'])(
    'should not declare any %s field as a bare object',
    (dto) => {
      const bare = Object.entries(schemas[dto].properties ?? {}).filter(
        ([, prop]) =>
          (prop as SchemaObject).type === 'object' &&
          !(prop as SchemaObject).properties,
      );
      expect(bare.map(([name]) => name)).toEqual([]);
    },
  );
});
