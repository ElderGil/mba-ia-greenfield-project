import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// openapi.json is exported from the decorators, and the gate checks that a
// fresh export is identical; these assertions are about the contract.
interface Operation {
  parameters?: { name: string; in: string }[];
  responses: Record<
    string,
    { content?: Record<string, { schema?: { format?: string } }> }
  >;
}
const document = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'openapi.json'), 'utf8'),
) as { paths: Record<string, Record<string, Operation>> };

const operations = Object.entries(document.paths).flatMap(([path, ops]) =>
  Object.entries(ops).map(([method, op]) => ({ path, method, op })),
);

describe('openapi.json contract', () => {
  it.each(
    operations
      .filter(({ path }) => path.includes('{id}'))
      .map(({ path, method, op }) => [`${method.toUpperCase()} ${path}`, op]),
  )('%s documents the 400 a malformed UUID gets', (_, op) => {
    expect(Object.keys(op.responses)).toContain('400');
  });

  it.each([
    ['/videos/{shortCode}/stream', ['200', '206']],
    ['/videos/{shortCode}/download', ['200']],
    ['/videos/{shortCode}/thumbnail', ['200']],
  ])('%s declares a binary body', (path, statuses) => {
    const responses = document.paths[path].get.responses;
    for (const status of statuses) {
      const content = Object.values(responses[status].content ?? {});
      expect(content.length).toBeGreaterThan(0);
      for (const media of content) {
        expect(media.schema?.format).toBe('binary');
      }
    }
  });
});
