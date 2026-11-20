import type { DataSource } from 'typeorm';
import { cleanAllTables } from './create-test-data-source';
import {
  assertTestDatabase,
  testBucketName,
  testDatabaseName,
} from './test-database';

function fakeDataSource(currentDatabase: string): {
  dataSource: DataSource;
  queries: string[];
} {
  const queries: string[] = [];
  const query = jest.fn((sql: string) => {
    queries.push(sql);
    return Promise.resolve(
      sql.includes('current_database()')
        ? [{ current_database: currentDatabase }]
        : [],
    );
  });
  return { dataSource: { query } as unknown as DataSource, queries };
}

describe('test database isolation', () => {
  describe('testDatabaseName', () => {
    it('should derive the test database from the configured one', () => {
      expect(testDatabaseName('streamtube')).toBe('streamtube_test');
    });

    it('should be idempotent, since setup files run once per test file', () => {
      expect(testDatabaseName(testDatabaseName('streamtube'))).toBe(
        'streamtube_test',
      );
    });
  });

  describe('testBucketName', () => {
    it('should derive an idempotent test bucket from the configured one', () => {
      expect(testBucketName('streamtube-media')).toBe('streamtube-media-test');
      expect(testBucketName('streamtube-media-test')).toBe(
        'streamtube-media-test',
      );
    });
  });

  describe('assertTestDatabase', () => {
    it('should reject a database whose name does not end in _test', async () => {
      const { dataSource } = fakeDataSource('streamtube');

      await expect(assertTestDatabase(dataSource)).rejects.toThrow(
        /streamtube/,
      );
    });

    it('should accept a test database', async () => {
      const { dataSource } = fakeDataSource('streamtube_test');

      await expect(assertTestDatabase(dataSource)).resolves.toBeUndefined();
    });
  });

  describe('cleanAllTables', () => {
    it('should refuse to delete anything outside a test database', async () => {
      const { dataSource, queries } = fakeDataSource('streamtube');

      await expect(cleanAllTables(dataSource)).rejects.toThrow();
      expect(queries.some((q) => /DELETE/i.test(q))).toBe(false);
    });

    it('should clean a test database', async () => {
      const { dataSource, queries } = fakeDataSource('streamtube_test');

      await cleanAllTables(dataSource);

      expect(queries.some((q) => q.includes('DELETE FROM "users"'))).toBe(true);
    });
  });
});
