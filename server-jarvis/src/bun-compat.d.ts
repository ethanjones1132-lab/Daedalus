// Global type compatibility shims for Bun + TypeScript 6.x.
//
// @types/bun 1.3+ types Response.json() as Promise<unknown> (strict) and
// omits some DOM streaming types. This file restores the ergonomic signatures
// the original codebase was written against.

declare global {
  interface Response {
    // Bun 1.3 types this as unknown; restore any so callers don't need
    // exhaustive type guards everywhere.
    json<T = any>(): Promise<T>;
  }

  interface Request {
    json<T = any>(): Promise<T>;
  }

  // ReadableStreamReadResult is a DOM type that @types/bun may not expose
  // globally. Bun's streams are Web-compatible, so this is safe.
  type ReadableStreamReadResult<T> =
    | { done: false; value: T }
    | { done: true; value?: undefined };
}

export {};
