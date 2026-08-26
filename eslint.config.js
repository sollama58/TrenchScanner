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
    files: ["**/*.test.ts", "**/*.test.tsx"],
    rules: {
      // Test files legitimately construct partial/mocked domain objects.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
