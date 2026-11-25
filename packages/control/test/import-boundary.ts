import { readdirSync, readFileSync } from "node:fs";
import { join, posix, relative, sep } from "node:path";

// Import specifiers in static imports, re-exports, side-effect imports and
// dynamic imports. Type-only imports are included: K1 forbids the
// dependency edge, not only its runtime load.
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

export interface SourceFile {
  /** Path relative to the package `src` directory, with `/` separators. */
  readonly path: string;
  readonly text: string;
}

export function importSpecifiers(text: string): string[] {
  return [...text.matchAll(SPECIFIER)].map((match) => match[1]!);
}

/**
 * Returns one message per forbidden edge. Sources may import only relative
 * paths inside `src`, and nothing under `catalog/` may import `operations/`.
 */
export function boundaryViolations(files: readonly SourceFile[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    for (const specifier of importSpecifiers(file.text)) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
        violations.push(`${file.path}: non-relative import "${specifier}"`);
        continue;
      }
      const target = posix.resolve("/src", posix.dirname(file.path), specifier);
      if (target !== "/src" && !target.startsWith("/src/")) {
        violations.push(`${file.path}: import "${specifier}" leaves src`);
        continue;
      }
      const inside = target.slice("/src/".length);
      if (file.path.startsWith("catalog/") && (inside === "operations" || inside.startsWith("operations/"))) {
        violations.push(`${file.path}: catalog imports operations through "${specifier}"`);
      }
    }
  }
  return violations;
}

export function readSources(srcDir: string): SourceFile[] {
  const files: SourceFile[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
        files.push({ path: relative(srcDir, full).split(sep).join("/"), text: readFileSync(full, "utf8") });
      }
    }
  };
  visit(srcDir);
  return files;
}
