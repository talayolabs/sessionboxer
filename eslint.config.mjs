// Lint gate (docs/TECH-DEBT.md, prioritised fix 4): the recommended rule sets plus the two rules
// that catch the bugs this codebase has actually had — swallowed errors and dropped promises.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "images/**", "scripts/**", "apps/web/public/**", "**/*.config.*"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/**/src/**/*.{ts,tsx}", "packages/**/src/**/*.{ts,tsx}"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "no-empty": "error",
      // Stripping ANSI escapes and NULs out of terminal output is this codebase's bread and butter.
      "no-control-regex": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
    },
  },
  { files: ["**/*.d.ts"], rules: { "@typescript-eslint/no-unused-vars": "off" } },
);
