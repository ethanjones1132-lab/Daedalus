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
