import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  auditTestOnlySnapshot,
  commitSha,
  isTestOrFixturePath,
  repositoryBranch,
  repositoryFilePath,
} from "../opencomputer/agents/test-coverage/tools/policy.ts";

test("recognizes common test and fixture paths without admitting production files", () => {
  for (const path of [
    "src/parser.test.ts",
    "tests/parser.ts",
    "pkg/parser_test.go",
    "test_parser.py",
    "features/permissions.feature",
    "src/__fixtures__/permissions.json",
  ]) {
    assert.equal(isTestOrFixturePath(path), true, path);
  }
  for (const path of ["src/parser.ts", "package.json", "docs/testing.md"] as const) {
    assert.equal(isTestOrFixturePath(path), false, path);
  }
});

test("validates repository paths and full commit SHAs", () => {
  assert.equal(repositoryFilePath("./test/parser.test.ts"), "test/parser.test.ts");
  assert.throws(() => repositoryFilePath("../src/parser.ts"), /Invalid/);
  assert.throws(() => repositoryFilePath("test\\parser.test.ts"), /Invalid/);
  assert.equal(commitSha("A".repeat(40)), "a".repeat(40));
  assert.throws(() => commitSha("abc123"), /40-character/);
  assert.equal(repositoryBranch("release/next"), "release/next");
  assert.throws(() => repositoryBranch("../main"), /unsupported/);
});

async function fixture(): Promise<{ baseline: string; working: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "coverage-policy-"));
  const baseline = join(root, "baseline");
  const working = join(root, "working");
  for (const directory of [baseline, working]) {
    await mkdir(join(directory, "src"), { recursive: true });
    await mkdir(join(directory, "test"), { recursive: true });
    await writeFile(join(directory, "src", "parser.ts"), "export const parse = () => true;\n");
    await writeFile(join(directory, "test", "parser.test.ts"), "// existing\n");
  }
  return { baseline, working, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("audits an updated test and a new fixture", async () => {
  const files = await fixture();
  try {
    await writeFile(join(files.working, "test", "parser.test.ts"), "// regression test\n");
    await mkdir(join(files.working, "test", "fixtures"), { recursive: true });
    await writeFile(join(files.working, "test", "fixtures", "invalid.json"), "{}\n");
    const result = await auditTestOnlySnapshot(files.baseline, files.working, [
      "test/parser.test.ts",
      "test/fixtures/invalid.json",
    ]);
    assert.deepEqual(result.map((file) => file.path), [
      "test/parser.test.ts",
      "test/fixtures/invalid.json",
    ]);
  } finally {
    await files.cleanup();
  }
});

test("rejects an unlisted production change", async () => {
  const files = await fixture();
  try {
    await writeFile(join(files.working, "src", "parser.ts"), "export const parse = () => false;\n");
    await writeFile(join(files.working, "test", "parser.test.ts"), "// regression test\n");
    await assert.rejects(
      auditTestOnlySnapshot(files.baseline, files.working, ["test/parser.test.ts"]),
      /unlisted change: src\/parser\.ts/,
    );
  } finally {
    await files.cleanup();
  }
});

test("rejects deletions and unchanged requested files", async () => {
  const deleted = await fixture();
  try {
    await rm(join(deleted.working, "test", "parser.test.ts"));
    await assert.rejects(
      auditTestOnlySnapshot(deleted.baseline, deleted.working, ["test/parser.test.ts"]),
      /does not publish file deletions/,
    );
  } finally {
    await deleted.cleanup();
  }

  const unchanged = await fixture();
  try {
    await assert.rejects(
      auditTestOnlySnapshot(unchanged.baseline, unchanged.working, ["test/parser.test.ts"]),
      /Requested file is unchanged/,
    );
  } finally {
    await unchanged.cleanup();
  }
});

test("rejects symlinked test additions", async () => {
  const files = await fixture();
  try {
    await symlink("../src/parser.ts", join(files.working, "test", "linked.test.ts"));
    await assert.rejects(
      auditTestOnlySnapshot(files.baseline, files.working, ["test/linked.test.ts"]),
      /Only regular files/,
    );
  } finally {
    await files.cleanup();
  }
});

test("rejects test files and aggregate changes over the publishing limits", async () => {
  const oversized = await fixture();
  try {
    await writeFile(
      join(oversized.working, "test", "oversized.test.ts"),
      Buffer.alloc(1_000_001, "x"),
    );
    await assert.rejects(
      auditTestOnlySnapshot(oversized.baseline, oversized.working, [
        "test/oversized.test.ts",
      ]),
      /exceeds the 1 MB limit/,
    );
  } finally {
    await oversized.cleanup();
  }

  const aggregate = await fixture();
  try {
    await writeFile(
      join(aggregate.working, "test", "first.test.ts"),
      Buffer.alloc(1_000_000, "a"),
    );
    await writeFile(
      join(aggregate.working, "test", "second.test.ts"),
      Buffer.alloc(1_000_000, "b"),
    );
    await writeFile(
      join(aggregate.working, "test", "third.test.ts"),
      "x",
    );
    await assert.rejects(
      auditTestOnlySnapshot(aggregate.baseline, aggregate.working, [
        "test/first.test.ts",
        "test/second.test.ts",
        "test/third.test.ts",
      ]),
      /exceed the 2 MB total limit/,
    );
  } finally {
    await aggregate.cleanup();
  }
});
