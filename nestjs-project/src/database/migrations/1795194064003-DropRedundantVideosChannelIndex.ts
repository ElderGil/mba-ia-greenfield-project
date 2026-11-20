import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropRedundantVideosChannelIndex1795194064003 implements MigrationInterface {
  name = 'DropRedundantVideosChannelIndex1795194064003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_023a8e4f3f1a34ff3d8ca04a4c"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_023a8e4f3f1a34ff3d8ca04a4c" ON "videos" ("channel_id") `,
    );
  }
}
