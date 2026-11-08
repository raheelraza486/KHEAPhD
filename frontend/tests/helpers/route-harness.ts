import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../../", import.meta.url));
const appRequire = createRequire(path.join(root, "package.json"));

/** Execute real Next route modules, replacing only external services. */
export function routeHarness(mocks: Record<string, unknown>) {
  const modules = new Map<string, { exports: Record<string, unknown> }>();
  function load(file: string): Record<string, unknown> {
    if (modules.has(file)) return modules.get(file)!.exports;
    const module = { exports: {} };
    modules.set(file, module);
    const code = ts.transpileModule(readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText;
    const resolve = (specifier: string): unknown => {
      if (specifier in mocks) return mocks[specifier];
      if (specifier.startsWith("@/") || specifier.startsWith(".")) {
        const target = specifier.startsWith("@/") ? path.join(root, specifier.slice(2)) : path.resolve(path.dirname(file), specifier);
        return load(target.endsWith(".ts") ? target : `${target}.ts`);
      }
      return appRequire(specifier);
    };
    new Function("require", "module", "exports", code)(resolve, module, module.exports);
    return module.exports;
  }
  return (route: string) => load(path.join(root, route)) as Record<string, (request: Request) => Promise<Response>>;
}
