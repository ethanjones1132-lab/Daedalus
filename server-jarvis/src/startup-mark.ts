// DD-083: the child's own clock, taken before its import graph runs.
//
// ESM hoists static imports, so a statement written above index.ts's import
// block would still execute only after every imported module's body. The only
// code that can run before the graph is the body of index.ts's *first* import,
// and only if that module imports nothing itself. That is this module: no
// imports, no disk, no config, no network — just the timestamp.
//
// index.ts keeps its existing `[Jarvis startup] process entry` line as the
// post-import mark. Both lines carry the same `uptime=<seconds>s
// timeOrigin=<epoch ms>` fields, so subtracting the two uptimes yields the
// loader+import time the packaged cold-start probe needs, and timeOrigin ties
// the child's clock to the wall clock. Same prefix and key=value shape as the
// post-import line, so the existing startup-log readers parse both.
console.log(
  `[Jarvis startup] pre-import uptime=${process.uptime()}s timeOrigin=${performance.timeOrigin}`,
);
