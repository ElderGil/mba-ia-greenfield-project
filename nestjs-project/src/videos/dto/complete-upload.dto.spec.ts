import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CompleteUploadDto } from './complete-upload.dto';

async function errorsFor(etag: string): Promise<string[]> {
  const dto = plainToInstance(CompleteUploadDto, {
    parts: [{ partNumber: 1, etag }],
  });
  const errors = await validate(dto);
  return errors.flatMap((e) =>
    (e.children ?? []).flatMap((c) =>
      (c.children ?? []).flatMap((g) => Object.keys(g.constraints ?? {})),
    ),
  );
}

describe('CompleteUploadDto', () => {
  it('should accept an S3 ETag', async () => {
    expect(await errorsFor('"d41d8cd98f00b204e9800998ecf8427e"')).toEqual([]);
  });

  it('should reject an ETag far longer than any S3 ETag', async () => {
    // 10 000 parts x an unbounded string fit in the 1 MB body otherwise.
    expect(await errorsFor(`"${'a'.repeat(200)}"`)).toContain('maxLength');
  });
});
