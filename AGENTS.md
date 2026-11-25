# AGENTS.md — urx-device

## Overview

Shared device knowledge for the YAMAHA URX22 / URX44 / URX44V: model capabilities, setting definitions, codecs and semantic operations in TypeScript, and the Device Center transport in Rust. Two applications consume it as a pinned Git submodule at `vendor/urx-device`: the router GUI (urx-router) and the `urx` command line tool (urx-cli). Neither application's code lives here.

## Structure

- `packages/control` — `@urx/device-control`. `src/catalog/` holds definitions and codecs; `src/operations/` holds operations over a transport the caller supplies. The catalog never imports operations
- `crates/transport` — `urx-device-transport`: discovery, connections, request/reply matching, notifications and subscriptions
- `scripts/` — repository tooling (`version.mjs`)
- `.github/required-checks.json` — the status checks the `main` ruleset requires, the only copy outside GitHub's settings

## Development

```sh
pnpm install --frozen-lockfile
pnpm version:check   # generated versions match the root package.json version
pnpm typecheck       # source config (no Node or DOM types) and test config
pnpm build           # tsc emit of packages/control into dist/
pnpm test            # vitest: packages/*/{src,test}/**/*.test.ts and scripts/**/*.test.mjs
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
```

A local verification names every one of these commands; a command left out is named as left out in the report.

## Boundaries

- **What belongs here is device semantics, not application policy.** GUI plans, undo history, rendering and GUI restoration policy stay in urx-router; command parsing, terminal output, exit codes and process lifecycle stay in urx-cli. An operation does not discover devices, select a device, or read process-global current-device state
- **The control package imports nothing but its own relative paths.** No Node built-ins, DOM, Tauri or package dependency in `src/`; `tsconfig.json` loads no Node or DOM types, and `test/import-boundary.test.ts` lists the files TypeScript loads for `tsconfig.json` and `tsconfig.catalog.json` and rejects any outside `src`, or under `src/operations` when loaded from the catalog. A test may use Node
- **The transport crate depends on neither Tauri nor Node-API.** Each application wraps it in its own adapter in its own repository
- **One definition per fact.** Ranges, units, rounding and capabilities are defined once in the catalog and referenced by operations and by the applications' bindings. No second value table, no copy of a codec in Rust
- **The setting registry is closed and static.** No runtime plug-in registration, declarative operation language, dependency-graph scheduler or general workflow engine. A composition is an explicit function calling individual operations in a fixed order

## Device-traffic rules

- **No added device reads.** An operation performs the reads its contract defines and no more: no equality checks, readback, mode probes, status polling or evidence-fetch reads for convenience. A required fresh read is never replaced by a cached value. Tests compare request traces with the defined reads
- **Requested values are sent as requested.** No GUI defaulting, state prediction, corrective writes, automatic restoration of related values, retries, rollback or replay. Device-driven changes to related values are accepted and observed
- **A request acknowledgment is not readback evidence**, and progress already accepted is kept when a later step fails
- **A single send is the baseline.** A second write for one setting needs measured evidence; stereo presentation alone is not that evidence
- **Write only confirmed parameters** — verified on the unit by writing a value and reading the result back from the hardware. A mapping whose evidence is missing stays unbound; never add a speculative address

## Primary sources

- Block diagram (`MWEM-D0`): <https://download.yamaha.com/download/files/2927153/>
- User guide (HTML): <https://manual.yamaha.com/audio/music_audio_production/urx44_urx22/ug/en-US/>

Observing the protocol from outside — sending a request and recording what comes back — is the permitted route. **Reading a distributed binary is not**: do not analyze firmware images or application binaries, and do not propose it.

## Documentation

- **English is the base language.** This file is English only and has no Japanese counterpart. Every other document for readers has its English text at its own path and a Japanese counterpart beside it (`README.ja.md`, `CONTRIBUTING.ja.md`, `SECURITY.ja.md`, `CODE_OF_CONDUCT.ja.md`), kept section for section and cross-linked at the top
- **Documentation writes no control-protocol parameter number and no raw value.** It names an item the way the unit's screen, its user guide or an application's UI names it. The numbers live in the source, its tests and comments
- **This repository is public.** Raw device evidence, real device identifiers, private research notes and links to private material stay out of it — source, comments, documentation, commit messages and pull request bodies alike

## Versioning and adoption

- The root `package.json` `version` is the only hand-edited version; `pnpm version:write` regenerates the package and crate versions and the crate's `Cargo.lock` entry, and CI fails on drift
- A version change is a pull request that carries nothing else (`chore(release): X.Y.Z`). A released tag `vX.Y.Z` matches that version and is never moved or rewritten
- A change lands here first; each application adopts a pinned commit in its own pull request with its own checks. A green run here is not evidence for either application. Fixes are never made inside a consumer's submodule checkout

## Repository checks

- The `main` ruleset requires the contexts listed in `.github/required-checks.json`. A workflow change keeps every pull-request workflow triggering unfiltered, keeps each gate an `if: always()` job that reads `needs.*.result`, and updates that file and the ruleset together
- Every job, and every step that fetches from outside GitHub, carries a `timeout-minutes`; third-party actions are pinned to a 40-character SHA with a version comment; nothing in CI writes to a pull request's branch

## Conventions

- Commits follow Conventional Commits. The release notes are generated from merged pull request titles, so a title is user-facing text
- A pull request body follows `.github/PULL_REQUEST_TEMPLATE.md`; `gh pr create --body` replaces the template, so reproduce its sections
- Identifiers and comments in English. Comments describe behavior, not history
- Retain the MIT copyright and permission notice on code moved from urx-router
