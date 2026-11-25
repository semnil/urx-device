# Contributing

> 日本語版は [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md) を参照してください.

urx-device is maintained by one person. It is the shared library behind [URX Router](https://github.com/semnil/urx-router) and the `urx` command line tool; most reports about device behavior belong to the application where you saw them.

Security problems go through [SECURITY.md](SECURITY.md), not the issue tracker.

## Ways to help

- **File an issue** for a definition, codec or transport behavior that is wrong in this library.
- **Send a pull request.** For anything that changes what is sent to the device, open an issue first: those changes need hardware evidence, and it is better to agree on the evidence before you write the code.

## Setup

Node.js 26 (`.node-version`), pnpm (`packageManager` in `package.json`) and rustup, which installs the Rust toolchain pinned in `rust-toolchain.toml`.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
cargo test --workspace --locked
```

## Conventions

- Identifiers and comments in English. Comments describe behavior, not history.
- Keep diffs minimal and match the surrounding style. Formatting-only changes are not accepted on their own.
- Run `cargo fmt --all` for Rust changes; CI fails on the diff and does not write anything back to your branch.
- The control package imports only its own relative paths, and the transport crate depends on neither Tauri nor Node-API.
- Documentation writes no control-protocol parameter number or raw value.
- Keep English and Japanese documents in sync.
