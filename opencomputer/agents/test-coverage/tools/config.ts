export const TARGET_REPOSITORY = {
  owner: "your-github-owner",
  repository: "your-repository",
  defaultBranch: "main",
} as const;

// Keep publishing disabled until a dry run against the configured repository
// has produced the intended test-only change and passed its validation commands.
export const PUBLISH_ENABLED = false;

export const DEFAULT_LOOKBACK_DAYS = 7;
export const MAX_RECENT_PULL_REQUESTS = 10;
