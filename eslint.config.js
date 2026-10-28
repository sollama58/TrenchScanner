import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/generated/**",
      "**/*.d.ts",
      "packages/core/prisma/migrations/**",
      // Throwaway verification scripts - see .gitignore.
      ".preview/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettierConfig,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Prefixing with _ is the standard convention for "intentionally unused" (destructured
      // params we don't need, catch bindings, etc.) - matches patterns already in this codebase.
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // We use `interface X extends Y {}` in a couple of places purely to attach a doc comment
      // to an otherwise-identical re-export (e.g. RugCheckProfile) - that's a legitimate pattern,
      // not an accident.
      "@typescript-eslint/no-empty-object-type": ["error", { allowInterfaces: "always" }],
    },
  },
  {
    // The server-side code, where an un-awaited promise is a write, a send or a trade that can fail
    // with nobody told (full audit 2026-10-27, CH-12). Type-aware, so it runs against each
    // workspace's tsconfig. A deliberate fire-and-forget says so with `void` and handles its own
    // rejection. Not on tests. scanJob.ts waits for its split (CH-5): its four hits are
    // scheduleDexInfo() calls that already catch, and want only a `void`.
    files: ["packages/core/src/**/*.ts", "apps/api/src/**/*.ts", "apps/worker/src/**/*.ts"],
    ignores: ["**/*.test.ts", "apps/worker/src/jobs/scanJob.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      // Test files legitimately construct partial/mocked domain objects.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
