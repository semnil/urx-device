import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { SyntaxKind, type Node } from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";

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

// The module specifier of an import-like node, or null when the node has a
// specifier that is not a literal (a computed dynamic import). Returns
// undefined for any other node.
function moduleSpecifier(node: Node): string | null | undefined {
  const literal = (expression: Node | undefined): string | null =>
    expression !== undefined &&
    (expression.kind === SyntaxKind.StringLiteral || expression.kind === SyntaxKind.NoSubstitutionTemplateLiteral)
      ? (expression as Node & { text: string }).text
      : null;
  switch (node.kind) {
    case SyntaxKind.ImportDeclaration:
      return literal((node as Node & { moduleSpecifier: Node }).moduleSpecifier);
    case SyntaxKind.ExportDeclaration: {
      const specifier = (node as Node & { moduleSpecifier?: Node }).moduleSpecifier;
      return specifier === undefined ? undefined : literal(specifier);
    }
    case SyntaxKind.ImportEqualsDeclaration: {
      const reference = (node as Node & { moduleReference: Node }).moduleReference;
      return reference.kind === SyntaxKind.ExternalModuleReference
        ? literal((reference as Node & { expression: Node }).expression)
        : undefined;
    }
    case SyntaxKind.CallExpression: {
      const call = node as Node & { expression: Node; arguments: readonly Node[] };
      return call.expression.kind === SyntaxKind.ImportKeyword ? literal(call.arguments[0]) : undefined;
    }
    case SyntaxKind.ImportType: {
      const argument = (node as Node & { argument: Node }).argument;
      return argument.kind === SyntaxKind.LiteralType ? literal((argument as Node & { literal: Node }).literal) : null;
    }
    default:
      return undefined;
  }
}

/**
 * Every module specifier in the package's sources that is not a literal
 * relative path: a package, `node:` or `#` subpath import, or a dynamic import
 * whose specifier is computed. Uses TypeScript's syntax tree, so comments and
 * strings are not specifiers.
 */
export function specifierViolations(packageDir: string): string[] {
  const src = join(packageDir, "src");
  const config = join(packageDir, "tsconfig.json");
  const violations: string[] = [];
  const api = new API({ cwd: packageDir });
  try {
    const snapshot = api.updateSnapshot({ openProject: config });
    const program = snapshot.getProject(config)?.program;
    if (program === undefined) {
      throw new Error(`no TypeScript project for ${config}`);
    }
    for (const name of program.getSourceFileNames()) {
      const file = resolve(name);
      if (!isInside(src, file)) {
        continue;
      }
      const display = relative(packageDir, file).split(sep).join("/");
      const visit = (node: Node): void => {
        const specifier = moduleSpecifier(node);
        if (specifier === null) {
          violations.push(`computed specifier: ${display}`);
        } else if (specifier !== undefined && !specifier.startsWith("./") && !specifier.startsWith("../")) {
          violations.push(`non-relative specifier "${specifier}": ${display}`);
        }
        node.forEachChild(visit);
      };
      const sourceFile = program.getSourceFile(name);
      if (sourceFile === undefined) {
        throw new Error(`TypeScript did not return ${name}`);
      }
      visit(sourceFile);
    }
    snapshot.dispose();
  } finally {
    api.close();
  }
  return violations;
}

/**
 * K1 boundary violations of the package at `packageDir`, which has a
 * `tsconfig.json` for all sources and a `tsconfig.catalog.json` rooted at the
 * catalog. Every specifier is a literal relative path, the whole program
 * loads nothing outside `src` but TypeScript's default library, and the
 * catalog program loads nothing under `src/operations`. A module that does not
 * resolve is not listed here; the package's type check reports it.
 */
export function boundaryViolations(packageDir: string): string[] {
  const src = join(packageDir, "src");
  const operations = join(src, "operations");
  const display = (file: string): string => relative(packageDir, file).split(sep).join("/");
  const violations = specifierViolations(packageDir);
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
