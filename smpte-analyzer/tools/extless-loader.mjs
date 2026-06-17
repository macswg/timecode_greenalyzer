// Minimal Node ESM resolve hook so this folder's scripts can import the app's
// source modules, which use Vite-style extensionless imports (e.g.
// `import ... from "./dropFrame"`). Node's resolver requires explicit
// extensions; this appends `.js` when a bare relative specifier doesn't resolve.
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith("./") || specifier.startsWith("../")) &&
      !/\.[mc]?js$/.test(specifier) && context.parentURL) {
    const base = dirname(fileURLToPath(context.parentURL));
    const candidate = resolvePath(base, specifier + ".js");
    if (existsSync(candidate)) {
      return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
