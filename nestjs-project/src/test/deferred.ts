// A promise resolved from outside, used to force one interleaving of two
// concurrent operations at a chosen await point.
export interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

export function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Resolves when the operation settles, whatever the outcome.
export async function settled(operation: Promise<unknown>): Promise<void> {
  await Promise.allSettled([operation]);
}
