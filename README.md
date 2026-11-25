# urx-device

[日本語](README.ja.md)

Shared device definitions, semantic operations and Device Center transport for the YAMAHA URX22, URX44 and URX44V. The router GUI and the `urx` command line tool consume this repository as a pinned Git submodule at `vendor/urx-device`.

**Status:** initial development toward `0.1.0`. The packages below have no device behavior yet.

## Layout

| Path | Contents |
| --- | --- |
| `packages/control` | `@urx/device-control`: TypeScript definitions, codecs and operations over a caller-supplied transport. `./catalog` and `./operations` are separate entry points; the catalog never imports operations or platform APIs |
| `crates/transport` | `urx-device-transport`: Rust Device Center transport, independent of Tauri and Node-API |

Application adapters, GUI plans and terminal behavior stay in the consuming applications.

## Building and testing

Requirements: Node.js 26 (`.node-version`), pnpm (`packageManager` in `package.json`) and rustup, which installs the Rust toolchain pinned in `rust-toolchain.toml`.

```sh
pnpm install --frozen-lockfile
pnpm version:check
pnpm typecheck
pnpm build
pnpm test
cargo test --workspace --locked
```

## Versioning

The root `package.json` `version` is the only hand-edited version. `pnpm version:write` regenerates the package and crate versions from it, and `pnpm version:check` fails when they differ.

## License

[MIT](LICENSE).
