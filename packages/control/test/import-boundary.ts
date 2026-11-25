import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const typescriptDir = dirname(createRequire(import.meta.url).resolve("typescript/package.json"));
const tsc = join(typescriptDir, "bin", "tsc");

/**
 * Every file the TypeScript program of `project` loads, as TypeScript resolves
 * it: static, type-only, dynamic and `import = require` references, triple-slash
 * references and re-exports, followed transitively. Comments and strings that
 * only look like imports are not references.
 */
export function programFiles(project: string): string[] {
  const output = execFileSync(process.execPath, [tsc, "--listFilesOnly", "-p", project], { encoding: "utf8" });
  return output
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => resolve(line));
}

// TypeScript's own default library files (lib.*.d.ts) are not package code.
function isDefaultLib(file: string): boolean {
  const name = basename(file);
  return name.startsWith("lib.") && name.endsWith(".d.ts") && file.includes(`${sep}node_modules${sep}`) && file.includes("typescript");
}

function isInside(dir: string, file: string): boolean {
  const path = relative(dir, file);
  return path !== "" && !path.startsWith("..") && !path.startsWith(sep) && !/^[A-Za-z]:/.test(path);
}

/**
 * K1 boundary violations of the package at `packageDir`, which has a
 * `tsconfig.json` for all sources and a `tsconfig.catalog.json` rooted at the
 * catalog. The whole program loads nothing outside `src` but TypeScript's
 * default library, and the catalog program loads nothing under
 * `src/operations`. A module that does not resolve is not listed here; the
 * package's type check reports it.
 */
export function boundaryViolations(packageDir: string): string[] {
  const src = join(packageDir, "src");
  const operations = join(src, "operations");
  const display = (file: string): string => relative(packageDir, file).split(sep).join("/");
  const violations: string[] = [];
  for (const file of programFiles(join(packageDir, "tsconfig.json"))) {
    if (!isInside(src, file) && !isDefaultLib(file)) {
      violations.push(`outside src: ${display(file)}`);
    }
  }
  for (const file of programFiles(join(packageDir, "tsconfig.catalog.json"))) {
    if (isInside(operations, file)) {
      violations.push(`reached from catalog: ${display(file)}`);
    }
  }
  return violations;
}
