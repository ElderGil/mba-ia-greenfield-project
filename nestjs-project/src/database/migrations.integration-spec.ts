import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';
import { CreateUsersAndChannels1775687773260 } from './migrations/1775687773260-CreateUsersAndChannels';
import { CreateAuthTokens1777579850478 } from './migrations/1777579850478-CreateAuthTokens';
import { CreateVideos1794877024750 } from './migrations/1794877024750-CreateVideos';
import { DropRedundantVideosChannelIndex1795194064003 } from './migrations/1795194064003-DropRedundantVideosChannelIndex';
import { createTestDataSource } from '../test/create-test-data-source';
import { assertTestDatabase } from '../test/test-database';
import { ALL_ENTITIES } from '../test/test-entities';

const MANAGED_TABLES = [
  'videos',
  'users',
  'channels',
  'refresh_tokens',
  'verification_tokens',
];
const MANAGED_ENUMS = ['videos_status_enum', 'verification_tokens_type_enum'];
// Dropped by DropRedundantVideosChannelIndex (covered by the composite index).
const REDUNDANT_CHANNEL_INDEX = 'IDX_023a8e4f3f1a34ff3d8ca04a4c';

// Explicit classes: ts-jest does not resolve migration globs reliably
// (.claude/rules/typeorm-migrations.md). The first test fails when a file
// the CLI (`migration:run`) would apply is missing from this list.
const ALL_MIGRATIONS = [
  CreateUsersAndChannels1775687773260,
  CreateAuthTokens1777579850478,
  CreateVideos1794877024750,
  DropRedundantVideosChannelIndex1795194064003,
];
const MIGRATION_FILES = readdirSync(join(__dirname, 'migrations')).filter((f) =>
  f.endsWith('.ts'),
);

function timestampOf(name: string): string {
  return /(\d{13})/.exec(name)?.[1] ?? name;
}

describe('Database migrations (integration)', () => {
  let dataSource: DataSource;

  async function existingTables(): Promise<string[]> {
    const rows = await dataSource.query<{ table_name: string }[]>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [MANAGED_TABLES],
    );
    return rows.map((r) => r.table_name);
  }

  async function existingEnums(): Promise<string[]> {
    const rows = await dataSource.query<{ typname: string }[]>(
      `SELECT typname FROM pg_type WHERE typname = ANY($1::text[])`,
      [MANAGED_ENUMS],
    );
    return rows.map((r) => r.typname);
  }

  async function indexExists(name: string): Promise<boolean> {
    const rows = await dataSource.query<unknown[]>(
      `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = $1`,
      [name],
    );
    return rows.length > 0;
  }

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES, {
      migrations: ALL_MIGRATIONS,
    });

    await dataSource.initialize();
    // This spec drops the whole schema.
    await assertTestDatabase(dataSource);

    for (const table of MANAGED_TABLES) {
      await dataSource.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
    }
    await dataSource.query(`DROP TABLE IF EXISTS "migrations" CASCADE`);
    for (const type of MANAGED_ENUMS) {
      await dataSource.query(`DROP TYPE IF EXISTS "public"."${type}" CASCADE`);
    }
  });

  afterAll(async () => {
    // Leave the database fully migrated for the suites that run next.
    await dataSource.runMigrations();
    await dataSource.destroy();
  });

  it('registers every migration file in src/database/migrations', () => {
    expect(ALL_MIGRATIONS.map((m) => timestampOf(m.name)).sort()).toEqual(
      MIGRATION_FILES.map(timestampOf).sort(),
    );
  });

  it('applies every migration and leaves none pending', async () => {
    const ran = await dataSource.runMigrations();

    expect(ran).toHaveLength(MIGRATION_FILES.length);
    expect(await dataSource.showMigrations()).toBe(false);
    expect(await existingTables()).toEqual([
      'channels',
      'refresh_tokens',
      'users',
      'verification_tokens',
      'videos',
    ]);
    expect(await indexExists(REDUNDANT_CHANNEL_INDEX)).toBe(false);
  });

  it('reverts the whole chain to an empty schema and re-applies it', async () => {
    for (let i = 0; i < MIGRATION_FILES.length; i++) {
      await dataSource.undoLastMigration();
    }

    expect(await existingTables()).toEqual([]);
    expect(await existingEnums()).toEqual([]);

    const ran = await dataSource.runMigrations();

    expect(ran).toHaveLength(MIGRATION_FILES.length);
    expect(await dataSource.showMigrations()).toBe(false);
    expect(await indexExists(REDUNDANT_CHANNEL_INDEX)).toBe(false);
  });
});
