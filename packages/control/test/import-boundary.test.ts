import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { boundaryViolations, importSpecifiers, readSources } from "./import-boundary.js";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));

describe("control package import boundary (K1)", () => {
  it("finds both entry points in the source tree", () => {
    const paths = readSources(srcDir).map((file) => file.path);
    expect(paths).toContain("catalog/index.ts");
    expect(paths).toContain("operations/index.ts");
  });

  it("has no forbidden import in the source tree", () => {
    expect(boundaryViolations(readSources(srcDir))).toEqual([]);
  });

  it("reads static, type-only, side-effect, re-export and dynamic specifiers", () => {
    const text = [
      'import { a } from "./a.js";',
      'import type { B } from "../b.js";',
      'import "./c.js";',
      'export * from "./d.js";',
      'const e = await import("./e.js");',
    ].join("\n");
    expect(importSpecifiers(text)).toEqual(["./a.js", "../b.js", "./c.js", "./d.js", "./e.js"]);
  });

  it("rejects platform and package imports", () => {
    const files = [
      { path: "operations/x.ts", text: 'import { readFile } from "node:fs";' },
      { path: "catalog/y.ts", text: 'import type { Window } from "@tauri-apps/api/window";' },
    ];
    expect(boundaryViolations(files)).toEqual([
      'operations/x.ts: non-relative import "node:fs"',
      'catalog/y.ts: non-relative import "@tauri-apps/api/window"',
    ]);
  });

  it("rejects a catalog-to-operations edge, including a type-only one", () => {
    const files = [
      { path: "catalog/a.ts", text: 'import type { Op } from "../operations/index.js";' },
      { path: "catalog/sub/b.ts", text: 'import { run } from "../../operations/run.js";' },
    ];
    expect(boundaryViolations(files)).toEqual([
      'catalog/a.ts: catalog imports operations through "../operations/index.js"',
      'catalog/sub/b.ts: catalog imports operations through "../../operations/run.js"',
    ]);
  });

  it("allows operations to import the catalog", () => {
    const files = [{ path: "operations/a.ts", text: 'import { x } from "../catalog/index.js";' }];
    expect(boundaryViolations(files)).toEqual([]);
  });

  it("rejects an import that leaves src", () => {
    const files = [{ path: "catalog/a.ts", text: 'import { x } from "../../test/x.js";' }];
    expect(boundaryViolations(files)).toEqual(['catalog/a.ts: import "../../test/x.js" leaves src']);
  });
});
