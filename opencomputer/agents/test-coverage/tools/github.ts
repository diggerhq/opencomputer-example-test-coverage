import {
  bearer,
  type DataValue,
  defineConnection,
  defineTool,
  useSecret,
} from "@opencomputer/agent";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  DEFAULT_LOOKBACK_DAYS,
  MAX_RECENT_PULL_REQUESTS,
  TARGET_REPOSITORY,
} from "../config.js";
import {
  auditTestOnlySnapshot,
  commitSha,
  repositoryBranch,
  repositorySegment,
} from "./policy.js";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = "/workspace/repositories";
const BASELINE_ROOT = "/workspace/repository-baselines";

const owner = repositorySegment(TARGET_REPOSITORY.owner, "configured owner");
const repository = repositorySegment(
  TARGET_REPOSITORY.repository,
  "configured repository",
);
const defaultBranch = repositoryBranch(TARGET_REPOSITORY.defaultBranch);

const github = defineConnection({
  id: "github-test-coverage",
  origin: "https://api.github.com",
  methods: ["GET", "POST", "PUT"],
  pathPrefix: "/repos/",
  headers: {
    Accept: "application/vnd.github+json",
    Authorization: bearer(useSecret("GITHUB_PAT")),
    "User-Agent": "opencomputer-example-test-coverage",
    "X-GitHub-Api-Version": "2022-11-28",
  },
});

const codeload = defineConnection({
  id: "github-codeload",
  origin: "https://codeload.github.com",
  methods: ["GET"],
});

type GitHubRepository = { default_branch: string };
type GitHubRef = { object: { sha: string } };
type GitHubFile = {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
};
type GitHubPull = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  base: { ref: string };
};
type GitHubOpenPull = { number: number; html_url: string };
type GitHubContent = { sha: string; type: string };

function checkoutPath(): string {
  return resolve(REPOSITORY_ROOT, `${owner}--${repository}`);
}

function baselinePath(): string {
  return resolve(BASELINE_ROOT, `${owner}--${repository}`);
}

async function githubResponse(
  path: string,
  init?: RequestInit,
  allowNotFound = false,
): Promise<Response | undefined> {
  const response = await github.fetch(path, init);
  if (allowNotFound && response.status === 404) return undefined;
  if (!response.ok) {
    const message = await response.text();
    throw new Error(`GitHub API ${response.status}: ${message.slice(0, 2_000)}`);
  }
  return response;
}

async function githubJson<T>(
  path: string,
  init?: RequestInit,
  allowNotFound = false,
): Promise<T | undefined> {
  const response = await githubResponse(path, init, allowNotFound);
  return response ? (await response.json()) as T : undefined;
}

function jsonRequest(method: "POST" | "PUT", body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method,
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

export const getRecentMergedChanges = defineTool({
  name: "get_recent_merged_changes",
  description:
    "Read recently merged pull requests and changed files from the single code-configured GitHub repository.",
  input: {
    type: "object",
    properties: {
      lookbackDays: {
        type: "integer",
        minimum: 1,
        maximum: 30,
        default: DEFAULT_LOOKBACK_DAYS,
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: MAX_RECENT_PULL_REQUESTS,
        default: MAX_RECENT_PULL_REQUESTS,
      },
    },
    additionalProperties: false,
  },
  async run({ input, signal, reportProgress }): Promise<DataValue> {
    const lookbackDays = Math.min(30, Math.max(1, Number(input.lookbackDays ?? DEFAULT_LOOKBACK_DAYS)));
    const limit = Math.min(
      MAX_RECENT_PULL_REQUESTS,
      Math.max(1, Number(input.limit ?? MAX_RECENT_PULL_REQUESTS)),
    );
    const since = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1_000);
    const metadata = await githubJson<GitHubRepository>(
      `/repos/${owner}/${repository}`,
      { signal },
    );
    if (metadata!.default_branch !== defaultBranch) {
      throw new Error(
        `Configured default branch ${defaultBranch} does not match GitHub default ${metadata!.default_branch}`,
      );
    }
    const head = await githubJson<GitHubRef>(
      `/repos/${owner}/${repository}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
      { signal },
    );
    const closed = await githubJson<GitHubPull[]>(
      `/repos/${owner}/${repository}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
      { signal },
    );
    const merged = (closed ?? [])
      .filter((pull) => pull.merged_at && new Date(pull.merged_at) >= since)
      .slice(0, limit);

    const pullRequests: DataValue[] = [];
    for (const [index, pull] of merged.entries()) {
      await reportProgress({
        status: "reading-pull-request",
        current: index + 1,
        total: merged.length,
        number: pull.number,
      });
      const files = await githubJson<GitHubFile[]>(
        `/repos/${owner}/${repository}/pulls/${pull.number}/files?per_page=100`,
        { signal },
      );
      pullRequests.push({
        number: pull.number,
        title: pull.title,
        body: pull.body ?? "",
        url: pull.html_url,
        mergedAt: pull.merged_at!,
        mergeCommitSha: pull.merge_commit_sha ?? "",
        baseBranch: pull.base.ref,
        filesTruncated: (files ?? []).length === 100,
        files: (files ?? []).map((file) => ({
          path: file.filename,
          status: file.status,
          additions: file.additions,
          deletions: file.deletions,
          changes: file.changes,
          patch: file.patch ?? "",
        })),
      });
    }

    return {
      repository: `${owner}/${repository}`,
      defaultBranch,
      headSha: head!.object.sha,
      since: since.toISOString(),
      mergedPullRequests: pullRequests,
    };
  },
});

export const materializeConfiguredRepository = defineTool({
  name: "materialize_configured_repository",
  description:
    "Download the configured GitHub repository at an exact commit into /workspace/repositories and create a private baseline used to enforce test-only publishing.",
  input: {
    type: "object",
    properties: {
      ref: { type: "string", pattern: "^[0-9a-fA-F]{40}$" },
    },
    required: ["ref"],
    additionalProperties: false,
  },
  async run({ input, signal, reportProgress }) {
    const ref = commitSha(input.ref);
    const destination = checkoutPath();
    const baseline = baselinePath();
    const temporary = await mkdtemp(join(tmpdir(), "coverage-repository-"));
    const archive = join(temporary, "repository.tar.gz");

    await reportProgress({ status: "downloading", repository: `${owner}/${repository}`, ref });
    try {
      const response = await github.fetch(
        `/repos/${owner}/${repository}/tarball/${encodeURIComponent(ref)}`,
        { signal },
      );
      let archiveResponse = response;
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new Error("GitHub archive redirect omitted Location");
        const url = new URL(location);
        if (url.origin !== "https://codeload.github.com") {
          throw new Error(`GitHub archive redirected to an unsupported origin: ${url.origin}`);
        }
        archiveResponse = await codeload.fetch(`${url.pathname}${url.search}`, { signal });
      }
      if (!archiveResponse.ok) {
        const message = await archiveResponse.text();
        throw new Error(`GitHub archive ${archiveResponse.status}: ${message.slice(0, 1_000)}`);
      }
      await writeFile(archive, new Uint8Array(await archiveResponse.arrayBuffer()));
      await mkdir(REPOSITORY_ROOT, { recursive: true });
      await mkdir(BASELINE_ROOT, { recursive: true });
      await rm(destination, { recursive: true, force: true });
      await rm(baseline, { recursive: true, force: true });
      await mkdir(destination, { recursive: true });
      await execFileAsync(
        "tar",
        ["-xzf", archive, "--strip-components=1", "-C", destination],
        { signal },
      );
      await cp(destination, baseline, { recursive: true, dereference: false });
      return {
        repository: `${owner}/${repository}`,
        ref,
        path: destination,
        note: "Edit and test only this snapshot. Publishing compares it with a private baseline.",
      };
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
});

export const openTestCoveragePullRequest = defineTool({
  name: "open_test_coverage_pull_request",
  description:
    "Audit the materialized snapshot, reject every non-test or unlisted change, create a deterministic branch, commit test files, and create or reuse a GitHub pull request.",
  input: {
    type: "object",
    properties: {
      baseSha: { type: "string", pattern: "^[0-9a-fA-F]{40}$" },
      title: { type: "string", minLength: 1, maxLength: 200 },
      body: { type: "string", minLength: 1, maxLength: 20_000 },
      commitMessage: { type: "string", minLength: 1, maxLength: 200 },
      paths: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: { type: "string", minLength: 1 },
      },
      draft: { type: "boolean", default: false },
      dryRun: { type: "boolean", default: false },
    },
    required: ["baseSha", "title", "body", "commitMessage", "paths"],
    additionalProperties: false,
  },
  async run({ input, signal, reportProgress }): Promise<DataValue> {
    const baseSha = commitSha(input.baseSha);
    const branch = `test/coverage-${baseSha.slice(0, 12)}`;
    const title = String(input.title).trim();
    const body = String(input.body).trim();
    const commitMessage = String(input.commitMessage).trim();
    const requiredSections = [
      "Risky behavior now covered",
      "Test files added/updated",
      "Validation",
      "Why these tests materially reduce regression risk",
    ];
    for (const section of requiredSections) {
      if (!body.toLowerCase().includes(section.toLowerCase())) {
        throw new Error(`Pull-request body is missing: ${section}`);
      }
    }

    const metadata = await githubJson<GitHubRepository>(
      `/repos/${owner}/${repository}`,
      { signal },
    );
    if (metadata!.default_branch !== defaultBranch) {
      throw new Error("The code-configured default branch no longer matches GitHub");
    }

    const head = `${owner}:${branch}`;
    const existing = await githubJson<GitHubOpenPull[]>(
      `/repos/${owner}/${repository}/pulls?state=open&head=${encodeURIComponent(head)}&base=${encodeURIComponent(defaultBranch)}`,
      { signal },
    );
    if (existing?.length) {
      return {
        status: "existing",
        number: existing[0].number,
        url: existing[0].html_url,
        branch,
      };
    }

    const requestedPaths = Array.isArray(input.paths) ? input.paths : [];
    const files = await auditTestOnlySnapshot(
      baselinePath(),
      checkoutPath(),
      requestedPaths,
    );
    if (input.dryRun) {
      return {
        status: "dry-run",
        repository: `${owner}/${repository}`,
        base: defaultBranch,
        baseSha,
        branch,
        files: files.map((file) => ({ path: file.path, bytes: file.bytes })),
      };
    }

    await reportProgress({ status: "creating-branch", branch });
    const branchRef = await githubJson<GitHubRef>(
      `/repos/${owner}/${repository}/git/ref/heads/${encodeURIComponent(branch)}`,
      { signal },
      true,
    );
    if (!branchRef) {
      await githubJson(
        `/repos/${owner}/${repository}/git/refs`,
        jsonRequest("POST", { ref: `refs/heads/${branch}`, sha: baseSha }, signal),
      );
    }

    for (const [index, file] of files.entries()) {
      await reportProgress({
        status: "committing",
        file: file.path,
        current: index + 1,
        total: files.length,
      });
      const encodedPath = file.path.split("/").map(encodeURIComponent).join("/");
      const current = await githubJson<GitHubContent>(
        `/repos/${owner}/${repository}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`,
        { signal },
        true,
      );
      if (current && current.type !== "file") {
        throw new Error(`${file.path} is not a regular repository file`);
      }
      await githubJson(
        `/repos/${owner}/${repository}/contents/${encodedPath}`,
        jsonRequest("PUT", {
          message: commitMessage,
          branch,
          content: Buffer.from(file.content, "utf8").toString("base64"),
          ...(current ? { sha: current.sha } : {}),
        }, signal),
      );
    }

    await reportProgress({ status: "opening-pull-request" });
    const pull = await githubJson<GitHubOpenPull>(
      `/repos/${owner}/${repository}/pulls`,
      jsonRequest("POST", {
        title,
        body,
        head: branch,
        base: defaultBranch,
        draft: Boolean(input.draft),
      }, signal),
    );
    return {
      status: "created",
      number: pull!.number,
      url: pull!.html_url,
      branch,
    };
  },
});
