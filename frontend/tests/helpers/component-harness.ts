import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../../", import.meta.url));
const appRequire = createRequire(path.join(root, "package.json"));

/** Render real components without a browser or an auth service. */
export function componentHarness() {
  const modules = new Map<string, { exports: Record<string, unknown> }>();
  function load(file: string): Record<string, unknown> {
    if (modules.has(file)) return modules.get(file)!.exports;
    const module = { exports: {} };
    modules.set(file, module);
    const code = ts.transpileModule(readFileSync(file, "utf8"), {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    const resolve = (specifier: string): unknown => {
      if (specifier === "@/lib/supabase/client") return { createClient: () => { throw new Error("Rendering must not contact Supabase"); } };
      if (specifier === "@/app/profile/actions") {
        const fail = () => { throw new Error("Rendering must not invoke a server action"); };
        return { saveChain: fail, updateSavedChain: fail };
      }
      if (specifier.startsWith("@/") || specifier.startsWith(".")) {
        const target = specifier.startsWith("@/") ? path.join(root, specifier.slice(2)) : path.resolve(path.dirname(file), specifier);
        return load(/\.tsx?$/.test(target) ? target : existsSync(`${target}.tsx`) ? `${target}.tsx` : `${target}.ts`);
      }
      return appRequire(specifier);
    };
    new Function("require", "module", "exports", code)(resolve, module, module.exports);
    return module.exports;
  }
  return (file: string) => load(path.join(root, file));
}
