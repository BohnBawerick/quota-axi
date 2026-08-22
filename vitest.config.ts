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
    // The TUI decides its colour depth from the ambient environment
    // (src/tui.ts detectTuiColorDepth, called from src/commands.ts with the
    // real process.env and process.stdout). Tests inject their own stdout sink
    // and then assert on plain text, so an ambient FORCE_COLOR turns three
    // card-grid assertions in test/cli.test.ts red on one machine and green on
    // another. Pin both inputs: FORCE_COLOR "0" is "not forced", after which
    // NO_COLOR settles the answer at "none" whatever TERM, COLORTERM or the
    // TTY say.
    env: {
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
  },
});
