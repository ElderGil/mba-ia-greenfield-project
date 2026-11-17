import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { S3StorageService } from './s3-storage.service';
import { StorageModule } from './storage.module';

describe('StorageModule', () => {
  it('compiles and provides S3StorageService', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [storageConfig],
        }),
        StorageModule,
      ],
    }).compile();

    const service = module.get(S3StorageService);
    expect(service).toBeInstanceOf(S3StorageService);
    await module.close();
  });
});
