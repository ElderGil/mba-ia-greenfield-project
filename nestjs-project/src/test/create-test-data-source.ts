import { DataSource, EntitySchema, MigrationInterface } from 'typeorm';
import databaseConfig from '../config/database.config';
import { assertTestDatabase } from './test-database';

interface TestDataSourceOptions {
  migrations?: (new () => MigrationInterface)[];
}

// Connects to the test database (DB_NAME is rewritten by test-env.ts), whose
// schema global-setup.ts built from the migrations.
export function createTestDataSource(
  entities: (EntitySchema<any> | (new (...args: never[]) => unknown))[],
  options: TestDataSourceOptions = {},
): DataSource {
  const { migrations } = options;
  const db = databaseConfig();
  return new DataSource({
    type: 'postgres',
    host: db.host,
    port: db.port,
    username: db.username,
    password: db.password,
    database: db.name,
    entities,
    synchronize: false,
    ...(migrations !== undefined && { migrations, migrationsRun: false }),
  });
}

export async function cleanAllTables(dataSource: DataSource): Promise<void> {
  await assertTestDatabase(dataSource);
  await dataSource.query(
    `DO $$ BEGIN IF to_regclass('public.videos') IS NOT NULL THEN DELETE FROM "videos"; END IF; END $$;`,
  );
  await dataSource.query('DELETE FROM "refresh_tokens"');
  await dataSource.query('DELETE FROM "verification_tokens"');
  await dataSource.query('DELETE FROM "channels"');
  await dataSource.query('DELETE FROM "users"');
}
