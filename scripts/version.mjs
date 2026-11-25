// V5: the root package.json "version" is the only hand-edited common version.
// Every other version field is generated from it. `--check` (the default)
// reports drift without rewriting; `--write` regenerates the fields.
// The crate's entry in Cargo.lock is checked too; `--write` has Cargo
// regenerate it with `cargo update --workspace`.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_VERSION = /^\d+\.\d+\.\d+$/;

/** Generated version fields, relative to the repository root. */
export const TARGETS = [
  { path: "packages/control/package.json", kind: "json" },
  { path: "crates/transport/Cargo.toml", kind: "cargo" },
  { path: "Cargo.lock", kind: "lock" },
];

const CRATE_NAME = "urx-device-transport";

export function canonicalVersion(rootPackageText) {
  const version = JSON.parse(rootPackageText).version;
  if (typeof version !== "string" || !RELEASE_VERSION.test(version)) {
    throw new Error(`root package.json version must be MAJOR.MINOR.PATCH, got ${JSON.stringify(version)}`);
  }
  return version;
}

export function jsonVersion(text) {
  return JSON.parse(text).version;
}

export function setJsonVersion(text, version) {
  const manifest = JSON.parse(text);
  manifest.version = version;
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// Locates the `version = "..."` line of the [package] table.
function cargoVersionLine(text) {
  const lines = text.split("\n");
  let inPackage = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith("[")) {
      inPackage = line === "[package]";
      continue;
    }
    const match = inPackage ? /^version\s*=\s*"([^"]*)"\s*$/.exec(line) : null;
    if (match) {
      return { lines, index, version: match[1] };
    }
  }
  throw new Error("Cargo.toml has no [package] version line");
}

export function cargoVersion(text) {
  return cargoVersionLine(text).version;
}

export function setCargoVersion(text, version) {
  const { lines, index } = cargoVersionLine(text);
  lines[index] = `version = "${version}"`;
  return lines.join("\n");
}

/** Version of the named package's entry in Cargo.lock. */
export function lockVersion(text, name = CRATE_NAME) {
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const packageName = /^name\s*=\s*"([^"]*)"\s*$/m.exec(block)?.[1];
    if (packageName === name) {
      const version = /^version\s*=\s*"([^"]*)"\s*$/m.exec(block)?.[1];
      if (version === undefined) {
        throw new Error(`Cargo.lock entry ${name} has no version`);
      }
      return version;
    }
  }
  throw new Error(`Cargo.lock has no entry for ${name}`);
}

const READ = { json: jsonVersion, cargo: cargoVersion, lock: lockVersion };
const WRITE = { json: setJsonVersion, cargo: setCargoVersion };

function cargoUpdateWorkspace(root) {
  execFileSync("cargo", ["update", "--workspace"], { cwd: root, stdio: "inherit" });
}

/** Returns the targets whose version differs from the canonical version. */
export function drift(root) {
  const expected = canonicalVersion(readFileSync(join(root, "package.json"), "utf8"));
  return TARGETS.flatMap((target) => {
    const current = READ[target.kind](readFileSync(join(root, target.path), "utf8"));
    return current === expected ? [] : [{ ...target, current, expected }];
  });
}

/**
 * Regenerates the manifest versions, then the Cargo.lock entry through
 * `updateLock` (Cargo by default). Throws when a version still differs, so a
 * failed Cargo run fails the command.
 */
export function write(root, { updateLock = cargoUpdateWorkspace } = {}) {
  const changed = drift(root);
  for (const target of changed) {
    if (target.kind in WRITE) {
      const file = join(root, target.path);
      writeFileSync(file, WRITE[target.kind](readFileSync(file, "utf8"), target.expected));
    }
  }
  if (changed.length > 0) {
    updateLock(root);
  }
  const remaining = drift(root);
  if (remaining.length > 0) {
    throw new Error(`versions still differ after --write: ${remaining.map((target) => target.path).join(", ")}`);
  }
  return changed;
}

function main(argv) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const mode = argv[0] ?? "--check";
  if (mode !== "--check" && mode !== "--write") {
    process.stderr.write("usage: node scripts/version.mjs [--check|--write]\n");
    return 2;
  }
  const changed = mode === "--write" ? write(root) : drift(root);
  for (const target of changed) {
    const verb = mode === "--write" ? "updated" : "differs";
    process.stderr.write(`${target.path}: ${verb} (${target.current} -> ${target.expected})\n`);
  }
  return mode === "--check" && changed.length > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
