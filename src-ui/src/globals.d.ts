// Module declarations for non-TS imports.
declare module '*.css' {
  const content: string;
  export default content;
}
declare module '*.svg' {
  const content: string;
  export default content;
}
declare module '*.png' {
  const content: string;
  export default content;
}
// Vite raw text imports (e.g. `import src from './App.tsx?raw'`).
declare module '*?raw' {
  const content: string;
  export default content;
}
// Vite's build-time glob import. The pulse-liveness guard uses it to enumerate
// every UI source module, so a new file cannot ship an animation the guard has
// never seen. Only the shape this repo uses is declared; the cast to
// `Record<string, string>` happens at the call site.
interface ImportMeta {
  glob: (
    pattern: string,
    options?: { query?: string; import?: string; eager?: boolean },
  ) => Record<string, unknown>;
}
