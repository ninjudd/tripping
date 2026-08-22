import { configDefaults, defineConfig } from "vitest/config";

// .claude/ holds session worktrees — nested checkouts whose test/ dirs a
// bare `vitest run` at the repo root would otherwise walk into and run.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "**/.claude/**"],
  },
});
