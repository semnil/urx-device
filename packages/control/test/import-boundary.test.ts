import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { boundaryViolations, programFiles } from "./import-boundary.js";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const temporary: string[] = [];

// A package directory with this package's two tsconfig files, the two empty
// entry points and the given extra files (path relative to the package).
function fixture(files: Record<string, string>): string {
  // Inside the package, so that `typescript` and `vitest` resolve from it.
  const dir = mkdtempSync(join(packageDir, "test", ".fixture-"));
  temporary.push(dir);
  for (const config of ["tsconfig.json", "tsconfig.catalog.json"]) {
    cpSync(join(packageDir, config), join(dir, config));
  }
  const all = { "src/catalog/index.ts": "export {};\n", "src/operations/index.ts": "export {};\n", ...files };
  for (const [path, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  return dir;
}

afterEach(() => {
  for (const dir of temporary.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("control package import boundary (K1)", () => {
  it("lists both entry points in the package program", () => {
    const files = programFiles(join(packageDir, "tsconfig.json")).map((file) => file.split(/[\\/]/).slice(-2).join("/"));
    expect(files).toContain("catalog/index.ts");
    expect(files).toContain("operations/index.ts");
  });

  it("has no violation in the package", () => {
    expect(boundaryViolations(packageDir)).toEqual([]);
  });

  const reachesOperations: Record<string, Record<string, string>> = {
    "a direct re-export": { "src/catalog/a.ts": 'export * from "../operations/index.js";\n' },
    "a re-export through a shared helper": {
      "src/catalog/a.ts": 'export * from "../shared/helper.js";\n',
      "src/shared/helper.ts": 'export * from "../operations/index.js";\n',
    },
    "an import with a comment before the specifier": {
      "src/catalog/a.ts": 'import /* note */ "../operations/index.js";\nexport {};\n',
    },
    "a dynamic import with a template literal": {
      "src/catalog/a.ts": "export const load = () => import(`../operations/index.js`);\n",
    },
    "a type-only import": { "src/catalog/a.ts": 'import type {} from "../operations/index.js";\nexport {};\n' },
    "a type query import": { "src/catalog/a.ts": 'export type T = typeof import("../operations/index.js");\n' },
    "a triple-slash path reference": { "src/catalog/a.ts": '/// <reference path="../operations/index.ts" />\nexport {};\n' },
    "an import through an .mts module": {
      "src/catalog/a.ts": 'export * from "../shared/helper.mjs";\n',
      "src/shared/helper.mts": 'export * from "../operations/index.js";\n',
    },
    "an import-equals require through a .cts module": {
      "src/catalog/a.ts": 'export * from "../shared/helper.cjs";\n',
      "src/shared/helper.cts": 'import ops = require("../operations/plain.cjs");\nexport = ops;\n',
      "src/operations/plain.cts": "export = {};\n",
    },
  };

  for (const [name, files] of Object.entries(reachesOperations)) {
    it(`rejects operations reached from the catalog by ${name}`, () => {
      const violations = boundaryViolations(fixture(files));
      expect(violations.some((line) => line.startsWith("reached from catalog: src/operations/"))).toBe(true);
    });
  }

  it("rejects a declaration file outside src", () => {
    const dir = fixture({
      "src/catalog/a.ts": '/// <reference path="../../types/extra.d.ts" />\nexport {};\n',
      "types/extra.d.ts": "declare const extra: number;\n",
    });
    expect(boundaryViolations(dir)).toEqual(["outside src: types/extra.d.ts"]);
  });

  it("rejects a package type reference", () => {
    const violations = boundaryViolations(fixture({ "src/operations/a.ts": 'import type { Mock } from "vitest";\nexport type M = Mock;\n' }));
    expect(violations).toContain('non-relative specifier "vitest": src/operations/a.ts');
    expect(violations.some((line) => line.startsWith("outside src: "))).toBe(true);
  });

  const computed: Record<string, Record<string, string>> = {
    "a variable": { "src/catalog/a.ts": 'const path = "../operations/index.js";\nexport const load = () => import(path);\n' },
    "string concatenation": { "src/catalog/a.ts": 'export const load = () => import("../" + "operations/index.js");\n' },
    "a template literal with a substitution": {
      "src/catalog/a.ts": 'const dir = "operations";\nexport const load = () => import(`../${dir}/index.js`);\n',
    },
    "a variable in a shared helper": {
      "src/catalog/a.ts": 'export * from "../shared/helper.js";\n',
      "src/shared/helper.ts": 'const path = "../operations/index.js";\nexport const load = () => import(path);\n',
    },
  };

  for (const [name, files] of Object.entries(computed)) {
    it(`rejects a dynamic import computed from ${name}`, () => {
      const violations = boundaryViolations(fixture(files));
      expect(violations.some((line) => line.startsWith("computed specifier: src/"))).toBe(true);
    });
  }

  it("rejects a package.json subpath import", () => {
    const dir = fixture({
      "package.json": '{"type":"module","imports":{"#local-codec":"./src/shared/codec.ts"}}\n',
      "src/catalog/a.ts": 'export * from "#local-codec";\n',
      "src/shared/codec.ts": "export const codec = 1;\n",
    });
    expect(boundaryViolations(dir)).toContain('non-relative specifier "#local-codec": src/catalog/a.ts');
  });

  it("rejects node: and package imports", () => {
    const dir = fixture({ "src/operations/a.ts": 'import "node:fs";\nexport * from "some-package";\n' });
    expect(boundaryViolations(dir)).toEqual(
      expect.arrayContaining(['non-relative specifier "node:fs": src/operations/a.ts', 'non-relative specifier "some-package": src/operations/a.ts']),
    );
  });

  it("ignores comments and strings that only look like imports", () => {
    const dir = fixture({
      "src/catalog/a.ts": [
        '// import { x } from "../operations/index.js";',
        'export const label = \'connect from "Device Center"\';',
        'export const note = "import(\\"../operations/index.js\\")";',
      ].join("\n"),
    });
    expect(boundaryViolations(dir)).toEqual([]);
  });

  it("allows operations to import the catalog and both to share a helper", () => {
    const dir = fixture({
      "src/operations/a.ts": 'export * from "../catalog/index.js";\nexport * from "../shared/helper.js";\n',
      "src/catalog/b.ts": 'export * from "../shared/helper.js";\n',
      "src/shared/helper.ts": "export const shared = 1;\n",
    });
    expect(boundaryViolations(dir)).toEqual([]);
  });
});
