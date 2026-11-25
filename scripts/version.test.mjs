import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TARGETS, canonicalVersion, cargoVersion, drift, setCargoVersion, write } from "./version.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const temporary = [];

// Copies only the version-bearing files into a scratch root.
function scratchRoot() {
  const root = mkdtempSync(join(tmpdir(), "urx-device-version-"));
  temporary.push(root);
  for (const path of ["package.json", ...TARGETS.map((target) => target.path)]) {
    cpSync(join(repoRoot, path), join(root, path), { recursive: true });
  }
  return root;
}

function setRootVersion(root, version) {
  const file = join(root, "package.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  manifest.version = version;
  writeFileSync(file, JSON.stringify(manifest, null, 2));
}

afterEach(() => {
  for (const root of temporary.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("generated common versions (V5)", () => {
  it("has no drift in the repository", () => {
    expect(drift(repoRoot)).toEqual([]);
  });

  it("reports every target after a canonical change without rewriting it", () => {
    const root = scratchRoot();
    setRootVersion(root, "0.2.0");
    const before = TARGETS.map((target) => readFileSync(join(root, target.path), "utf8"));
    expect(drift(root).map((target) => [target.path, target.expected])).toEqual(
      TARGETS.map((target) => [target.path, "0.2.0"]),
    );
    expect(TARGETS.map((target) => readFileSync(join(root, target.path), "utf8"))).toEqual(before);
  });

  it("reports a single hand-edited target", () => {
    const root = scratchRoot();
    const cargo = join(root, "crates/transport/Cargo.toml");
    writeFileSync(cargo, setCargoVersion(readFileSync(cargo, "utf8"), "9.9.9"));
    expect(drift(root).map((target) => [target.path, target.current])).toEqual([
      ["crates/transport/Cargo.toml", "9.9.9"],
    ]);
  });

  it("regenerates the targets and then reports no drift", () => {
    const root = scratchRoot();
    setRootVersion(root, "0.3.1");
    expect(write(root)).toHaveLength(TARGETS.length);
    expect(drift(root)).toEqual([]);
  });

  it("rejects a non-release canonical version", () => {
    expect(() => canonicalVersion('{"version":"0.1"}')).toThrow(/MAJOR.MINOR.PATCH/);
    expect(() => canonicalVersion("{}")).toThrow(/MAJOR.MINOR.PATCH/);
  });

  it("reads only the [package] version in Cargo.toml", () => {
    const text = ['[workspace.package]', 'version = "1.0.0"', "", "[package]", 'name = "x"', 'version = "0.4.0"', "", "[dependencies]", 'y = { version = "2" }'].join("\n");
    expect(cargoVersion(text)).toBe("0.4.0");
    expect(setCargoVersion(text, "0.5.0")).toBe(text.replace('version = "0.4.0"', 'version = "0.5.0"'));
    expect(() => cargoVersion('[package]\nname = "x"\n')).toThrow(/no \[package\] version/);
  });
});
