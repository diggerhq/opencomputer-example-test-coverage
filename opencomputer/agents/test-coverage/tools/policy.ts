import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "__pycache__",
  "node_modules",
  "venv",
]);

export type AuditedFile = {
  readonly path: string;
  readonly content: string;
  readonly bytes: number;
};

export function repositorySegment(value: unknown, label: string): string {
  const normalized = String(value ?? "").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error(`${label} contains unsupported characters`);
  }
  return normalized;
}

export function repositoryBranch(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (
    !/^[A-Za-z0-9._/-]+$/.test(normalized) ||
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes("//") ||
    normalized.includes("..")
  ) {
    throw new Error("configured default branch contains unsupported characters");
  }
  return normalized;
}

export function commitSha(value: unknown): string {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error("baseSha must be a full 40-character Git commit SHA");
  }
  return normalized;
}

export function repositoryFilePath(value: unknown): string {
  const normalized = String(value ?? "").trim().replace(/^\.\//, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.includes("\0")
  ) {
    throw new Error(`Invalid repository file path: ${JSON.stringify(value)}`);
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Invalid repository file path: ${JSON.stringify(value)}`);
  }
  return segments.join("/");
}

export function isTestOrFixturePath(value: unknown): boolean {
  const path = repositoryFilePath(value);
  const segments = path.toLowerCase().split("/");
  const name = segments.at(-1)!;
  const testDirectory = segments.slice(0, -1).some((segment) =>
    [
      "__fixtures__",
      "__snapshots__",
      "__tests__",
      "fixture",
      "fixtures",
      "spec",
      "specs",
      "test",
      "testdata",
      "tests",
    ].includes(segment),
  );
  return testDirectory ||
    /(?:^|[._-])(?:spec|test)\.[^.]+$/.test(name) ||
    /^test_.+\.py$/.test(name) ||
    /_test\.(?:go|py|rb|rs)$/.test(name) ||
    name.endsWith(".feature");
}

async function manifest(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();

  async function visit(relative: string): Promise<void> {
    const directory = join(root, relative);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = join(root, ...path.split("/"));
      const stat = await lstat(absolute);
      if (stat.isDirectory()) {
        await visit(path);
      } else if (stat.isFile()) {
        const bytes = await readFile(absolute);
        result.set(path, `file:${createHash("sha256").update(bytes).digest("hex")}`);
      } else if (stat.isSymbolicLink()) {
        result.set(path, `symlink:${await readlink(absolute)}`);
      } else {
        result.set(path, `other:${stat.mode}`);
      }
    }
  }

  await visit("");
  return result;
}

export async function auditTestOnlySnapshot(
  baselineRoot: string,
  workingRoot: string,
  requestedPaths: readonly unknown[],
): Promise<readonly AuditedFile[]> {
  if (!requestedPaths.length) throw new Error("At least one test path is required");

  const paths = requestedPaths.map(repositoryFilePath);
  if (new Set(paths).size !== paths.length) {
    throw new Error("Test paths must be unique");
  }
  for (const path of paths) {
    if (!isTestOrFixturePath(path)) {
      throw new Error(`Publishing is restricted to tests and fixtures: ${path}`);
    }
  }

  const [baseline, working] = await Promise.all([
    manifest(baselineRoot),
    manifest(workingRoot),
  ]);
  const requested = new Set(paths);
  const changed = new Set<string>();
  for (const path of new Set([...baseline.keys(), ...working.keys()])) {
    if (baseline.get(path) !== working.get(path)) changed.add(path);
  }

  for (const path of changed) {
    if (!requested.has(path)) {
      throw new Error(`Snapshot includes an unlisted change: ${path}`);
    }
    if (!working.has(path)) {
      throw new Error(`The example does not publish file deletions: ${path}`);
    }
    if (!working.get(path)?.startsWith("file:")) {
      throw new Error(`Only regular files can be published: ${path}`);
    }
  }
  for (const path of paths) {
    if (!changed.has(path)) throw new Error(`Requested file is unchanged: ${path}`);
  }

  const files: AuditedFile[] = [];
  let totalBytes = 0;
  for (const path of paths) {
    const bytes = await readFile(join(workingRoot, ...path.split("/")));
    if (bytes.byteLength > 1_000_000) {
      throw new Error(`Test file exceeds the 1 MB limit: ${path}`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > 2_000_000) {
      throw new Error("Test changes exceed the 2 MB total limit");
    }
    files.push({ path, content: bytes.toString("utf8"), bytes: bytes.byteLength });
  }
  return files;
}
