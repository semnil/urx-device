// Pins which Dependabot pull requests .github/workflows/dependabot-auto-merge.yml lets merge on
// their own: every updated dependency a semver patch or a semver minor update, a minor update
// of a cargo crate below 1.0 excepted, in a pull request that is one commit, the head, which
// dependabot[bot] wrote, GitHub (web-flow) committed and GitHub verified the signature of.
//
// It RUNS the workflow's own `run:` block rather than reading it, against a stub `gh` that
// records what it was asked to do, with the metadata handed to it in the shape
// dependabot/fetch-metadata writes `updated-dependencies-json`: a JSON array of its
// `updatedDependency` objects, field names as that action spells them. The dependencies below
// are this repository's own, so the cases are the kinds Dependabot opens here; the
// multi-dependency ones are the arrangement fetch-metadata's summary outputs read wrongly,
// which is why the block reads every dependency instead. The stub answers the pull request's
// commit list in the shape the REST pulls API returns it, because fetch-metadata reads the
// first commit alone. It can also be told to fail the first calls of one kind, the way the
// GitHub CLI fails on an error the API answers with, and a stub `sleep` records each wait the
// block asks for instead of waiting.

import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runBlock } from "./workflow-block.test-util.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const WORKFLOW = ".github/workflows/dependabot-auto-merge.yml";

const PR_URL = "https://github.com/semnil/urx-device/pull/1";
const HEAD_SHA = "2222222222222222222222222222222222222222";
const OTHER_SHA = "3333333333333333333333333333333333333333";

// One commit as the REST pulls API lists it, with the fields the block reads.
const commit = (sha, login, verified = true, committer = "web-flow") => ({
  sha,
  author: { login },
  committer: { login: committer },
  commit: { verification: { verified } },
});
const DEPENDABOT_AT_HEAD = [commit(HEAD_SHA, "dependabot[bot]")];

// Skipped where the tools are absent, and the skip is named rather than silent. On CI they are
// present, so there the skip is refused outright: a green run that judged nothing is the
// failure this file exists to catch.
const has = (command) => !spawnSync(command, ["--version"], { encoding: "utf8" }).error;
const toolsAvailable = has("bash") && has("jq");

const TEXT = readFileSync(join(ROOT, WORKFLOW), "utf8");
const BLOCK = runBlock(TEXT, "UPDATED:");
// The metadata step's own keys, up to the step after it.
const METADATA_AT = TEXT.indexOf("- id: metadata");
const METADATA_STEP = TEXT.slice(METADATA_AT, TEXT.indexOf("\n      - ", METADATA_AT));

// One `updatedDependency` as fetch-metadata builds it. `packageEcosystem` is the second segment
// of Dependabot's branch name, so it reads `npm_and_yarn` and `github_actions` rather than the
// names dependabot.yml uses. An update with no version reaches it as an empty `updateType`.
const dependency = (name, ecosystem, updateType, prevVersion, newVersion) => ({
  dependencyName: name,
  dependencyType: "direct:production",
  updateType,
  directory: "/",
  packageEcosystem: ecosystem,
  targetBranch: "main",
  prevVersion,
  newVersion,
  compatScore: 0,
  maintainerChanges: false,
  dependencyGroup: "",
  alertState: "",
  ghsaId: "",
  cvss: 0,
});

const PATCH = "version-update:semver-patch";
const MINOR = "version-update:semver-minor";
const MAJOR = "version-update:semver-major";

const TYPES_NODE_PATCH = dependency("@types/node", "npm_and_yarn", PATCH, "26.6.7", "26.6.10");
const TYPESCRIPT_MINOR = dependency("typescript", "npm_and_yarn", MINOR, "7.0.2", "7.1.0");
// The 0.x exception is cargo's alone, so an npm package below 1.0 is the case that shows it.
const NPM_BELOW_1_MINOR = dependency("an-npm-package", "npm_and_yarn", MINOR, "0.28.2", "0.29.0");
const SERDE_JSON_PATCH = dependency("serde_json", "cargo", PATCH, "1.0.154", "1.0.155");
const SERDE_JSON_MINOR = dependency("serde_json", "cargo", MINOR, "1.0.155", "1.1.0");
// The transport crate's one dependency is at 1.0, so a crate below 1.0 stands in for the kind
// the exception is about.
const CRATE_BELOW_1_PATCH = dependency("a-crate", "cargo", PATCH, "0.2.191", "0.2.192");
const CRATE_BELOW_1_MINOR = dependency("a-crate", "cargo", MINOR, "0.10.9", "0.11.0");
const SETUP_NODE_MINOR = dependency("actions/setup-node", "github_actions", MINOR, "7.1.0", "7.2.0");
const VITEST_MAJOR = dependency("vitest", "npm_and_yarn", MAJOR, "5.1.1", "6.0.0");
const SERDE_JSON_MAJOR = dependency("serde_json", "cargo", MAJOR, "1.0.155", "2.0.0");
// An update with no version: an action pinned to a branch moves to a commit, and so would a
// submodule, which this repository does not have. fetch-metadata gives either no type and no
// previous version.
const ACTION_SHA = dependency(
  "an-owner/an-action",
  "github_actions",
  "",
  "",
  "683b588c487a69d01f6c6ddf40f036ff682cc2c8",
);
const SUBMODULE_COMMIT = dependency(
  "vendor/a-submodule",
  "submodules",
  null,
  "",
  "2612f186cf4796f93afa8e12719d958b1a3efc91",
);

const scratch = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// `failures` names how many calls of a kind fail before one succeeds: `commits` the commit
// list, `view` the read of the head and of auto-merge, `enable` and `disable` the two writes.
// `afterWait` is what the pull request answers once the block has waited: another `head`,
// another `autoMerge`, or a read that fails (`viewFails`).
function run(
  updated,
  {
    autoMerge = "false",
    commits = DEPENDABOT_AT_HEAD,
    metadataOutcome = "success",
    currentHead = HEAD_SHA,
    failures = {},
    afterWait = {},
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "urx-device-dependabot-auto-merge-"));
  scratch.push(dir);
  mkdirSync(join(dir, "bin"));
  const calls = join(dir, "calls.log");
  writeFileSync(calls, "");
  const commitsFile = join(dir, "commits.json");
  if (commits !== null) writeFileSync(commitsFile, JSON.stringify(commits));
  for (const [kind, count] of Object.entries(failures)) writeFileSync(join(dir, `fail-${kind}`), String(count));
  // A path goes into the stub quoted: bare, bash reads the backslashes of a Windows path as
  // escapes and writes to a different file.
  const q = JSON.stringify;
  const waited = join(dir, "waited");
  writeFileSync(
    join(dir, "bin", "sleep"),
    ["#!/bin/bash", `printf '%s\\n' "sleep $*" >> ${q(calls)}`, `: > ${q(waited)}`].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(
    join(dir, "bin", "gh"),
    [
      "#!/bin/bash",
      `printf '%s\\n' "gh $*" >> ${q(calls)}`,
      "kind=",
      'if [[ "$1" == "api" ]]; then kind=commits; fi',
      'if [[ "$1 $2" == "pr view" ]]; then kind=view; fi',
      'if [[ "$1 $2 $3" == "pr merge --auto" ]]; then kind=enable; fi',
      'if [[ "$1 $2 $3" == "pr merge --disable-auto" ]]; then kind=disable; fi',
      `left=$(cat ${q(join(dir, "fail-"))}"$kind" 2>/dev/null || echo 0)`,
      'if [[ "$left" -gt 0 ]]; then',
      `  echo $((left - 1)) > ${q(join(dir, "fail-"))}"$kind"`,
      // The GitHub CLI prints the body of an error answer on stdout and its reading of it on stderr.
      `  echo '{"message":"Server Error"}'`,
      `  echo "stub gh: the $kind call failed" >&2; exit 1`,
      "fi",
      'if [[ "$1" == "api" ]]; then',
      commits === null ? "  echo 'HTTP 502' >&2; exit 1" : `  cat ${q(commitsFile)}; exit 0`,
      "fi",
      'if [[ "$1 $2" == "pr view" ]]; then',
      `  if [[ -e ${q(waited)} ]]; then`,
      afterWait.viewFails
        ? "    echo 'HTTP 502' >&2; exit 1"
        : `    printf '%s\\t%s\\n' '${afterWait.head ?? currentHead}' '${afterWait.autoMerge ?? autoMerge}'; exit 0`,
      "  fi",
      `  printf '%s\\t%s\\n' '${currentHead}' '${autoMerge}'`,
      "fi",
      "exit 0",
    ].join("\n"),
    { mode: 0o755 },
  );
  const path = join(dir, "block.sh");
  // The stubs go first on PATH from inside the script as well: Git for Windows' bash puts its
  // own /usr/bin, which holds a real `sleep`, ahead of the PATH it was started with.
  writeFileSync(path, `PATH="$PWD/bin:$PATH"\n${BLOCK}`);
  // GitHub's default shell for a `run:` block with no `shell:` key is `bash -e {0}`.
  const proc = spawnSync("bash", ["-e", path], {
    encoding: "utf8",
    cwd: dir,
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}${delimiter}${process.env.PATH}`,
      GITHUB_REPOSITORY: "semnil/urx-device",
      PR_URL,
      PR_NUMBER: "1",
      HEAD_SHA,
      METADATA_OUTCOME: metadataOutcome,
      UPDATED: typeof updated === "string" ? updated : JSON.stringify(updated),
    },
  });
  if (proc.error) throw new Error(`could not run the block: ${proc.error.message}`);
  return {
    status: proc.status,
    stdout: proc.stdout,
    stderr: proc.stderr,
    calls: readFileSync(calls, "utf8")
      .split("\n")
      .filter((line) => line !== ""),
  };
}

const COMMITS = "gh api repos/semnil/urx-device/pulls/1/commits?per_page=100";
const ENABLE = `gh pr merge --auto --merge --match-head-commit ${HEAD_SHA} ${PR_URL}`;
const VIEW = `gh pr view ${PR_URL} --json headRefOid,autoMergeRequest --jq [.headRefOid, (.autoMergeRequest != null)] | @tsv`;
const DISABLE = `gh pr merge --disable-auto ${PR_URL}`;
const WAIT = "sleep 10";

it("runs where the tools are, and never skips on CI", () => {
  if (!toolsAvailable) expect(process.env.CI, "bash and jq are missing on CI").toBeFalsy();
});

describe.skipIf(!toolsAvailable)("the decision", () => {
  const enables = [
    ["a patch update", [TYPES_NODE_PATCH]],
    ["a minor update of an npm package", [TYPESCRIPT_MINOR]],
    // The 0.x exception is cargo's alone: an npm package below 1.0 qualifies like any other.
    ["a minor update of an npm package below 1.0", [NPM_BELOW_1_MINOR]],
    ["a minor update of a crate at 1.0 or above", [SERDE_JSON_MINOR]],
    ["a patch update of a crate below 1.0", [CRATE_BELOW_1_PATCH]],
    ["a minor update of an action", [SETUP_NODE_MINOR]],
    ["several updates that each qualify", [SERDE_JSON_PATCH, CRATE_BELOW_1_PATCH, TYPES_NODE_PATCH]],
  ];
  it.each(enables)("enables auto-merge for %s", (_, updated) => {
    const result = run(updated);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([COMMITS, ENABLE]);
  });

  const disables = [
    ["a minor update of a crate below 1.0", [CRATE_BELOW_1_MINOR]],
    ["a major update", [VITEST_MAJOR]],
    ["several updates with a major update among them", [SERDE_JSON_MAJOR, CRATE_BELOW_1_PATCH]],
    ["an update with no version", [ACTION_SHA]],
    ["a submodule update", [SUBMODULE_COMMIT]],
    // fetch-metadata's `update-type` reads patch here: a dependency with no type is not counted.
    ["a patch update beside one with no version", [TYPES_NODE_PATCH, ACTION_SHA]],
    // fetch-metadata's `previous-version` reads 1.0.155 here: it is the first dependency's.
    ["a qualifying minor update beside a minor of a crate below 1.0", [SERDE_JSON_MINOR, CRATE_BELOW_1_MINOR]],
    ["a minor update of a crate whose previous version is missing", [{ ...SERDE_JSON_MINOR, prevVersion: "" }]],
    ["a minor update whose ecosystem is missing", [{ ...TYPESCRIPT_MINOR, packageEcosystem: "" }]],
    ["metadata listing no dependency", []],
    ["metadata fetch-metadata did not write", ""],
  ];
  it.each(disables)("leaves auto-merge off for %s", (_, updated) => {
    const result = run(updated);
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([VIEW]);
  });
});

describe.skipIf(!toolsAvailable)("the commit history", () => {
  const leavesOff = [
    ["a commit someone added after Dependabot's", [commit(OTHER_SHA, "dependabot[bot]"), commit(HEAD_SHA, "someone")]],
    ["one commit someone else wrote", [commit(HEAD_SHA, "someone")]],
    ["one Dependabot commit whose signature is not verified", [commit(HEAD_SHA, "dependabot[bot]", false)]],
    ["one Dependabot commit that is not the head", [commit(OTHER_SHA, "dependabot[bot]")]],
    ["one Dependabot commit someone else amended and signed", [commit(HEAD_SHA, "dependabot[bot]", true, "someone")]],
    [
      "two Dependabot commits with the head listed first",
      [commit(HEAD_SHA, "dependabot[bot]"), commit(OTHER_SHA, "dependabot[bot]")],
    ],
    ["no commit", []],
  ];
  it.each(leavesOff)("leaves auto-merge off for a qualifying update in %s", (_, commits) => {
    const result = run([TYPES_NODE_PATCH], { commits });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([COMMITS, VIEW]);
  });

  it("turns off an auto-merge an earlier head enabled when a commit was added", () => {
    const commits = [commit(OTHER_SHA, "dependabot[bot]"), commit(HEAD_SHA, "someone")];
    const result = run([TYPESCRIPT_MINOR], { commits, autoMerge: "true" });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([COMMITS, VIEW, DISABLE]);
  });

  it("fails when it cannot read the commits", () => {
    const result = run([TYPES_NODE_PATCH], { commits: null });
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([COMMITS, WAIT, COMMITS, WAIT, COMMITS]);
  });
});

describe.skipIf(!toolsAvailable)("the disable half", () => {
  it("turns off an auto-merge an earlier head enabled", () => {
    const result = run([VITEST_MAJOR], { autoMerge: "true" });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([VIEW, DISABLE]);
  });

  it("fails when it cannot read whether auto-merge is on", () => {
    const result = run([VITEST_MAJOR], { autoMerge: "" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "::error::could not read the head of the pull request and whether auto-merge is enabled",
    );
    expect(result.calls).toEqual([VIEW]);
  });

  it("fails rather than deciding when the metadata is not JSON", () => {
    const result = run("not json");
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
  });
});

// The deciding step runs after a failed metadata step only when that failure does not fail the job.
it("goes on to the deciding step after a failed metadata step, and hands it the outcome", () => {
  expect(METADATA_STEP).toMatch(/^\s+continue-on-error: true\b/m);
  expect(TEXT).toContain("METADATA_OUTCOME: ${{ steps.metadata.outcome }}");
});

it("runs the jobs for one pull request one at a time", () => {
  expect(TEXT).toContain("group: dependabot-auto-merge-${{ github.event.pull_request.number || github.run_id }}");
});

describe.skipIf(!toolsAvailable)("a failed metadata step", () => {
  it("turns off an auto-merge an earlier head enabled, and passes", () => {
    const result = run("", { metadataOutcome: "failure", autoMerge: "true" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("::warning::fetch-metadata did not classify this pull request (failure)");
    expect(result.calls).toEqual([VIEW, DISABLE]);
  });

  it("leaves auto-merge off, and passes", () => {
    const result = run("", { metadataOutcome: "failure" });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([VIEW]);
  });

  it("does not read the metadata a failed step left behind", () => {
    const result = run([TYPES_NODE_PATCH], { metadataOutcome: "failure", autoMerge: "true" });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([VIEW, DISABLE]);
  });
});

describe.skipIf(!toolsAvailable)("a run for an older head", () => {
  it("changes nothing for an update that would turn auto-merge off", () => {
    const result = run([VITEST_MAJOR], { autoMerge: "true", currentHead: OTHER_SHA });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([VIEW]);
  });

  it("changes nothing when the commits list the newer head", () => {
    const commits = [commit(OTHER_SHA, "dependabot[bot]")];
    const result = run([TYPES_NODE_PATCH], { commits, autoMerge: "true", currentHead: OTHER_SHA });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([COMMITS, VIEW]);
  });

  it("changes nothing after a failed metadata step", () => {
    const result = run("", { metadataOutcome: "failure", autoMerge: "true", currentHead: OTHER_SHA });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([VIEW]);
  });

  it("fails when it cannot read the head", () => {
    const result = run([VITEST_MAJOR], { autoMerge: "true", currentHead: "unreadable" });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([VIEW]);
  });
});

// Each of the four calls is made again at its own place in the block, so each has its own row:
// a row per call is what a missing retry at one of them fails. The disabling is made again
// behind a fresh read of the head and of auto-merge.
describe.skipIf(!toolsAvailable)("a failed call of the GitHub CLI", () => {
  const sites = [
    ["the read of the commits", "commits", [TYPES_NODE_PATCH], {}, [COMMITS, WAIT, COMMITS, ENABLE]],
    ["the enabling of auto-merge", "enable", [TYPES_NODE_PATCH], {}, [COMMITS, ENABLE, WAIT, ENABLE]],
    ["the read of the head", "view", [VITEST_MAJOR], { autoMerge: "true" }, [VIEW, WAIT, VIEW, DISABLE]],
    [
      "the disabling of auto-merge",
      "disable",
      [VITEST_MAJOR],
      { autoMerge: "true" },
      [VIEW, DISABLE, WAIT, VIEW, DISABLE],
    ],
  ];
  it.each(sites)("is made again when %s fails once, and the step passes", (_, kind, updated, options, calls) => {
    const result = run(updated, { ...options, failures: { [kind]: 1 } });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual(calls);
    expect(result.stderr).toContain("::warning::attempt 1 of 3 failed");
    expect(result.stderr).toContain(`stub gh: the ${kind} call failed`);
  });

  it("is made a third time when it fails twice", () => {
    const result = run([TYPES_NODE_PATCH], { failures: { enable: 2 } });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([COMMITS, ENABLE, WAIT, ENABLE, WAIT, ENABLE]);
    expect(result.stderr).toContain("::warning::attempt 2 of 3 failed");
    expect(result.stdout).toBe("");
  });

  const givesUp = [
    ["the read of the commits", "commits", [TYPES_NODE_PATCH], {}, [COMMITS, WAIT, COMMITS, WAIT, COMMITS]],
    ["the enabling of auto-merge", "enable", [TYPES_NODE_PATCH], {}, [COMMITS, ENABLE, WAIT, ENABLE, WAIT, ENABLE]],
    ["the read of the head", "view", [VITEST_MAJOR], { autoMerge: "true" }, [VIEW, WAIT, VIEW, WAIT, VIEW]],
    [
      "the disabling of auto-merge",
      "disable",
      [VITEST_MAJOR],
      { autoMerge: "true" },
      [VIEW, DISABLE, WAIT, VIEW, DISABLE, WAIT, VIEW, DISABLE],
    ],
  ];
  it.each(givesUp)("fails the step when %s fails three times", (_, kind, updated, options, calls) => {
    const result = run(updated, { ...options, failures: { [kind]: 9 } });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual(calls);
    expect(result.stderr).toContain(`stub gh: the ${kind} call failed`);
  });

  // The body of an error answer reaches stdout, where the block reads the answer from.
  it("decides on the answer of the attempt that succeeded alone", () => {
    const commits = [commit(HEAD_SHA, "someone")];
    const result = run([TYPES_NODE_PATCH], { commits, autoMerge: "true", failures: { commits: 1, view: 1 } });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([COMMITS, WAIT, COMMITS, VIEW, WAIT, VIEW, DISABLE]);
  });
});

// A wait is long enough for the pull request to change, so an attempt to turn auto-merge off
// after one acts on a fresh read rather than on the read taken before the wait.
describe.skipIf(!toolsAvailable)("a failed disabling of auto-merge, after the wait", () => {
  const disabling = { autoMerge: "true", failures: { disable: 1 } };

  it("is made a third time behind a third read when it fails twice", () => {
    const result = run([VITEST_MAJOR], { autoMerge: "true", failures: { disable: 2 } });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([VIEW, DISABLE, WAIT, VIEW, DISABLE, WAIT, VIEW, DISABLE]);
    expect(result.stderr).toContain("::warning::attempt 2 of 3 failed");
    expect(result.stdout).toBe("");
  });

  it("is not made again when the head has moved, and the step passes", () => {
    const result = run([VITEST_MAJOR], { ...disabling, afterWait: { head: OTHER_SHA } });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([VIEW, DISABLE, WAIT, VIEW]);
    expect(result.stdout).toContain(`::notice::the head of the pull request is now ${OTHER_SHA}`);
  });

  it("is not made again when auto-merge is off by then, and the step passes", () => {
    const result = run([VITEST_MAJOR], { ...disabling, afterWait: { autoMerge: "false" } });
    expect(result.status).toBe(0);
    expect(result.calls).toEqual([VIEW, DISABLE, WAIT, VIEW]);
    expect(result.stdout).toBe("");
  });

  it("is not made again when the read fails three times, and the step fails", () => {
    const result = run([VITEST_MAJOR], { ...disabling, afterWait: { viewFails: true } });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([VIEW, DISABLE, WAIT, VIEW, WAIT, VIEW, WAIT, VIEW]);
  });

  it("is not made again when the read cannot be understood, and the step fails", () => {
    const result = run([VITEST_MAJOR], { ...disabling, afterWait: { autoMerge: "" } });
    expect(result.status).toBe(1);
    expect(result.calls).toEqual([VIEW, DISABLE, WAIT, VIEW]);
    expect(result.stdout).toContain(
      "::error::could not read the head of the pull request and whether auto-merge is enabled",
    );
  });
});
