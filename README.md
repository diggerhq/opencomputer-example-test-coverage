# OpenComputer test-coverage agent

This agent reviews recently merged GitHub pull requests, identifies one
meaningful regression risk with weak test coverage, adds the smallest useful
tests, runs the relevant test targets, and opens a test-only pull request.

It is deliberately narrower than a general coding agent. The configured
repository is fixed in code, publishing rejects production-file changes, and
the agent cannot merge a pull request or reuse an arbitrary branch.

## How it works

```text
Recent merged pull requests
           |
           v
Risk and missing-test review
           |
           v
Exact default-branch snapshot + private baseline
           |
           v
Minimal tests -> relevant test commands
           |
           v
Test-only audit -> deterministic branch -> pull request
```

Each run looks back seven days by default and selects at most one coherent gap.
No material gap means no pull request.

## Prerequisites

- Node.js 22 or newer
- access to an OpenComputer project
- a fine-grained GitHub personal access token scoped to one target repository
  with **Contents: read and write** and **Pull requests: read and write**

The token is stored as an OpenComputer secret and injected only into the
declared `https://api.github.com/repos/` connection. It is never placed in a
clone URL, shell environment, prompt, or repository file.

## Configure the repository

Edit `opencomputer/agents/test-coverage/config.ts`:

```ts
export const TARGET_REPOSITORY = {
  owner: "your-github-owner",
  repository: "your-repository",
  defaultBranch: "main",
} as const;

export const PUBLISH_ENABLED = false;
```

This mapping is code-owned. Prompts, pull-request bodies, commit messages, and
repository files cannot redirect the agent to another repository.

Keep `PUBLISH_ENABLED` set to `false` for the first remote run. The agent still
materializes the repository, adds and runs tests, and audits the final snapshot,
but the publishing tool returns the proposed files without writing to GitHub.
Set it to `true` only after reviewing that result against a disposable fixture
repository.

## Install and run in Development

```bash
npm install
npx opencomputer link
npx opencomputer secrets set GITHUB_PAT --environment development --agent current
npm run deploy -- --watch
```

Start an explicit run in the development session:

```bash
npm run session -- "Review recent merged code and add the highest-value missing regression tests."
```

To inspect a wider window, send a structured payload from the playground or
session API:

```json
{
  "lookbackDays": 14,
  "dryRun": true
}
```

`dryRun: true` still materializes the repository, permits local test edits and
validation, and runs the final test-only audit, but does not create a branch or
pull request.

## Publishing boundary

The final tool compares the tested working snapshot with a private untouched
baseline. It rejects:

- production, configuration, documentation, or other non-test changes;
- changed files omitted from the requested publish list;
- file deletions and symlinks;
- unchanged files and oversized changes; and
- paths outside common test, spec, fixture, and testdata conventions.

If the missing coverage requires a production-code testability refactor, the
agent reports the blocker instead of expanding its write authority. Adapt the
policy deliberately if your repository uses a different test layout.

Branches are deterministically named `test/coverage-<head-sha>`. Repeating a
run for the same repository head returns the existing open pull request instead
of creating a duplicate.

Every created pull request includes:

- risky behavior now covered;
- test files added or updated;
- exact validation commands and observed results; and
- why the tests materially reduce regression risk.

## Local verification

```bash
npm test
npm run typecheck
```

This first version supports explicit runs. Do not claim recurring scheduling as
part of the example until code-defined schedules are available and verified on
the relevant default branches.
