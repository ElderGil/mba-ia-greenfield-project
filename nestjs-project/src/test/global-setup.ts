import { DataSource } from 'typeorm';
import type { PostgresConnectionOptions } from 'typeorm/driver/postgres/PostgresConnectionOptions';
import { AppDataSource } from '../database/data-source';
import { testDatabaseName } from './test-database';

const PG_DUPLICATE_DATABASE = '42P04';

// Runs once per Jest run, before any suite: creates the test database when
// missing and migrates it with the same DataSource options as the CLI
// (`npm run migration:run`), so every suite starts from the schema the
// migrations define (no `synchronize`). The options must include the
// entities: TypeORM installs the uuid-ossp extension the first migration
// relies on only when it sees uuid-generated columns. This module runs in
// Jest's parent process, where the CLI globs resolve; the explicit-class
// rule (typeorm-migrations.md) is for DataSources inside the test sandbox.
export default async function globalSetup(): Promise<void> {
  const cli = AppDataSource.options as PostgresConnectionOptions;
  const name = testDatabaseName(cli.database ?? 'streamtube');

  const admin = new DataSource({ ...cli, database: 'postgres' });
  await admin.initialize();
  try {
    const exists = await admin.query<unknown[]>(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [name],
    );
    if (exists.length === 0) {
      await admin.query(`CREATE DATABASE "${name}"`).catch((err: unknown) => {
        // Another Jest run created it in the meantime.
        if ((err as { code?: string }).code !== PG_DUPLICATE_DATABASE) {
          throw err;
        }
      });
    }
  } finally {
    await admin.destroy();
  }

  const test = new DataSource({ ...cli, database: name });
  await test.initialize();
  try {
    await test.runMigrations();
  } finally {
    await test.destroy();
  }
}
