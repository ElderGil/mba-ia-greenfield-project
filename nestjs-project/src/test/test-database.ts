import type { DataSource } from 'typeorm';

// The suites wipe tables, drop the schema (migrations spec) and fill the
// bucket, so they run on their own database and bucket, derived from the
// configured ones: `streamtube` -> `streamtube_test`.
const TEST_DATABASE_SUFFIX = '_test';
const TEST_BUCKET_SUFFIX = '-test';

function withSuffix(name: string, suffix: string): string {
  return name.endsWith(suffix) ? name : `${name}${suffix}`;
}

export function testDatabaseName(base: string): string {
  return withSuffix(base, TEST_DATABASE_SUFFIX);
}

export function testBucketName(base: string): string {
  return withSuffix(base, TEST_BUCKET_SUFFIX);
}

// Last line of defence before anything destructive: never touch a database
// that is not a test one, whatever the environment says.
export async function assertTestDatabase(
  dataSource: DataSource,
): Promise<void> {
  const [row] = await dataSource.query<{ current_database: string }[]>(
    'SELECT current_database()',
  );
  const name = row?.current_database ?? '';
  if (!name.endsWith(TEST_DATABASE_SUFFIX)) {
    throw new Error(
      `Refusing to modify database "${name}": tests only run against databases whose name ends in "${TEST_DATABASE_SUFFIX}"`,
    );
  }
}
