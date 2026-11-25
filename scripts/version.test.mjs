import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TARGETS, canonicalVersion, cargoVersion, drift, lockVersion, setCargoVersion, write } from "./version.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const temporary = [];

// Every version in a scratch root starts here, apart from the repository's own
// release version, so that each test creates the difference it names.
const INITIAL = "0.0.1";

// Writes the version-bearing files, all at INITIAL, into a scratch root.
function scratchRoot() {
  const root = mkdtempSync(join(tmpdir(), "urx-device-version-"));
  temporary.push(root);
  const files = {
    "package.json": `${JSON.stringify({ name: "urx-device", version: INITIAL }, null, 2)}\n`,
    "packages/control/package.json": `${JSON.stringify({ name: "@urx/device-control", version: INITIAL }, null, 2)}\n`,
    "crates/transport/Cargo.toml": `[package]\nname = "urx-device-transport"\nversion = "${INITIAL}"\nedition = "2021"\n`,
    "Cargo.lock": `version = 4\n\n[[package]]\nname = "urx-device-transport"\nversion = "${INITIAL}"\n`,
  };
  expect(Object.keys(files).sort()).toEqual(["package.json", ...TARGETS.map((target) => target.path)].sort());
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function setRootVersion(root, version) {
  const file = join(root, "package.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  manifest.version = version;
  writeFileSync(file, JSON.stringify(manifest, null, 2));
}

// Stands in for `cargo update --workspace`: sets the crate's Cargo.lock entry
// to the crate manifest's version.
function fakeLockUpdate(root) {
  const version = cargoVersion(readFileSync(join(root, "crates/transport/Cargo.toml"), "utf8"));
  const file = join(root, "Cargo.lock");
  const text = readFileSync(file, "utf8");
  writeFileSync(file, text.replace(/(name = "urx-device-transport"\nversion = )"[^"]*"/, `$1"${version}"`));
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

  it("regenerates the targets, including Cargo.lock, and then reports no drift", () => {
    const root = scratchRoot();
    setRootVersion(root, "0.3.1");
    const updates = [];
    expect(write(root, { updateLock: (dir) => (updates.push(dir), fakeLockUpdate(dir)) })).toHaveLength(TARGETS.length);
    expect(updates).toEqual([root]);
    expect(drift(root)).toEqual([]);
    expect(lockVersion(readFileSync(join(root, "Cargo.lock"), "utf8"))).toBe("0.3.1");
  });

  it("reports and regenerates a stale Cargo.lock entry alone", () => {
    const root = scratchRoot();
    const file = join(root, "Cargo.lock");
    writeFileSync(file, readFileSync(file, "utf8").replace(`version = "${INITIAL}"`, 'version = "0.0.9"'));
    expect(drift(root).map((target) => [target.path, target.current])).toEqual([["Cargo.lock", "0.0.9"]]);
    write(root, { updateLock: fakeLockUpdate });
    expect(drift(root)).toEqual([]);
  });

  it("fails when the lockfile update leaves Cargo.lock behind", () => {
    const root = scratchRoot();
    setRootVersion(root, "0.4.0");
    expect(() => write(root, { updateLock: () => {} })).toThrow(/still differ after --write: Cargo.lock/);
  });

  it("does not run the lockfile update when nothing differs", () => {
    const root = scratchRoot();
    const updates = [];
    expect(write(root, { updateLock: (dir) => updates.push(dir) })).toEqual([]);
    expect(updates).toEqual([]);
  });

  it("reads only the named package's Cargo.lock entry", () => {
    const text = ["version = 4", "", "[[package]]", 'name = "other"', 'version = "9.0.0"', "", "[[package]]", 'name = "urx-device-transport"', 'version = "0.7.0"', ""].join("\n");
    expect(lockVersion(text)).toBe("0.7.0");
    expect(() => lockVersion('version = 4\n\n[[package]]\nname = "other"\nversion = "1.0.0"\n')).toThrow(/no entry for urx-device-transport/);
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
