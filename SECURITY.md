# Security Policy

> 日本語版は [SECURITY.ja.md](SECURITY.ja.md) を参照してください.

urx-device is a library. It has no server component, no account system and no telemetry. Its only network access is the connection to Device Center on the same computer, made when an application asks for it.

## Supported versions

Only the latest release is supported. Fixes ship as a new release rather than as a backport; each application adopts it in its own release.

## Reporting a vulnerability

Report it privately through GitHub —
**[Security → Report a vulnerability](https://github.com/semnil/urx-device/security/advisories/new)**.
Please do not open a public issue for a security problem.

Helpful details: the release or commit, what an attacker gains, and the steps to reproduce it. Attach any file needed to reproduce rather than pasting device values into the report.

This is a single-maintainer project, so handling is best effort: expect a first reply within about a week. You will be credited in the advisory unless you prefer otherwise.

## In scope

- Code execution, memory corruption or unbounded resource use reachable from data the library parses: a settings file, or a message received from the Device Center connection
- Connections to anything other than Device Center on the same computer
- Secrets or signing material exposed in the repository or in CI

## Out of scope

- **Writes to the device.** Changing the connected unit's settings is what the library is for, not a flaw.
- Driving hardware over a control protocol determined by independent analysis, as such
- Vulnerabilities in the device firmware, in the units themselves, or in Yamaha's software — report those to Yamaha
- Findings that require an attacker who already executes code as your user
- Scanner output with no demonstrated impact
