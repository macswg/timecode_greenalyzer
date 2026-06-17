// Registers the extensionless-import resolve hook for the current process,
// so generator scripts can `import` the app source (which uses Vite-style
// extensionless relative imports) under plain Node.
import { register } from "node:module";
register("./extless-loader.mjs", import.meta.url);
