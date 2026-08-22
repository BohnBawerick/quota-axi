import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // `.stryker-tmp/` is where Stryker copies the project when someone runs a
    // mutation report locally. Vitest's default glob collects the copies, so an
    // in-flight or interrupted run silently multiplies the suite.
    //
    // The pattern must stay root-anchored: `**/.stryker-tmp/**` also matches
    // every path *inside* a sandbox, which excludes the whole suite from the
    // mutation run instead of protecting it.
    exclude: [...configDefaults.exclude, ".stryker-tmp/**"],
    // Several tests build or type-check a real consumer and take seconds, not
    // milliseconds: test/codex-built-cli-weekly.test.ts and three cases in
    // test/kimi-cli-readonly.test.ts run 6-8s once the machine is busy, against
    // vitest's 5s default. They then fail for lack of time rather than for a
    // real defect, which is the worst kind of red.
    testTimeout: 30_000,
  },
});
