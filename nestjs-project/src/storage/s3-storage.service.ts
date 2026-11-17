import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { Readable } from 'node:stream';
import type { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import storageConfig from '../config/storage.config';

export interface CompletedPartInput {
  partNumber: number;
  etag: string;
}

export interface StorageObjectMetadata {
  contentLength: number;
  contentType: string | undefined;
  etag: string | undefined;
}

export interface StorageObjectStream {
  stream: Readable;
  contentLength: number | undefined;
  contentRange: string | undefined;
  contentType: string | undefined;
}

@Injectable()
export class S3StorageService implements OnModuleInit {
  private readonly logger = new Logger(S3StorageService.name);
  private readonly client: S3Client;
  private readonly presignClient: S3Client;
  private readonly bucket: string;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = config.bucket;
    const baseOptions = {
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle,
    };

    this.client = new S3Client({
      ...baseOptions,
      endpoint: config.endpoint,
    });

    this.presignClient =
      config.publicEndpoint !== config.endpoint
        ? new S3Client({
            ...baseOptions,
            endpoint: config.publicEndpoint,
          })
        : this.client;
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (err: unknown) {
      const status = (err as { $metadata?: { httpStatusCode?: number } })
        ?.$metadata?.httpStatusCode;
      const name = (err as { name?: string })?.name;
      if (status === 404 || name === 'NotFound' || name === 'NoSuchBucket') {
        await this.client.send(
          new CreateBucketCommand({ Bucket: this.bucket }),
        );
        this.logger.log(`Created S3 bucket "${this.bucket}"`);
        return;
      }
      throw err;
    }
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const res = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: contentType,
      }),
    );
    if (!res.UploadId) {
      throw new Error('S3 CreateMultipartUpload did not return an UploadId');
    }
    return res.UploadId;
  }

  async getPresignedPartUrl(
    key: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds = 900,
  ): Promise<string> {
    const command = new UploadPartCommand({
      Bucket: this.bucket,
      Key: key,
      UploadId: uploadId,
      PartNumber: partNumber,
    });
    return getSignedUrl(this.presignClient, command, {
      expiresIn: expiresInSeconds,
    });
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: CompletedPartInput[],
  ): Promise<void> {
    const sortedParts = [...parts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((part) => ({
        PartNumber: part.partNumber,
        ETag: part.etag,
      }));

    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: { Parts: sortedParts },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async headObject(key: string): Promise<StorageObjectMetadata> {
    const res = await this.client.send(
      new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
    return {
      contentLength: res.ContentLength ?? 0,
      contentType: res.ContentType,
      etag: res.ETag,
    };
  }

  async putObject(
    key: string,
    body: Buffer | Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async getObjectStream(
    key: string,
    range?: string,
  ): Promise<StorageObjectStream> {
    const res = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(range !== undefined && { Range: range }),
      }),
    );
    if (!res.Body) {
      throw new Error(`Empty response body for S3 key "${key}"`);
    }

    const stream =
      res.Body instanceof Readable
        ? res.Body
        : Readable.fromWeb(
            res.Body.transformToWebStream() as unknown as NodeWebReadableStream<Uint8Array>,
          );

    return {
      stream,
      contentLength: res.ContentLength,
      contentRange: res.ContentRange,
      contentType: res.ContentType,
    };
  }

  async getPresignedGetUrl(
    key: string,
    expiresInSeconds = 900,
  ): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });
    return getSignedUrl(this.client, command, { expiresIn: expiresInSeconds });
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      }),
    );
  }
}
