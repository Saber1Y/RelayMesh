import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/dist/**", "**/.next/**", "contracts/artifacts/**"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", ignoreRestSiblings: true }],
    },
  },
  {
    // CommonJS config files read by tools that require it (PM2).
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { module: "writable", require: "readonly", __dirname: "readonly" } },
  },
);
