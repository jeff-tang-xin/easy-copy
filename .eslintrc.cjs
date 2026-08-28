/* eslint-env node */
module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  extends: [],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
    ecmaFeatures: { jsx: true },
    project: ["./tsconfig.json"],
  },
  settings: {
    react: { version: "detect" },
  },
  plugins: ["@typescript-eslint", "react", "react-hooks"],
  ignorePatterns: ["dist", "node_modules", "src-tauri", "*.config.ts", "*.config.cjs"],
  rules: {
    // ── TypeScript ──────────────────────────────────────
    "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    "@typescript-eslint/no-unused-expressions": "warn",
    "@typescript-eslint/prefer-optional-chain": "warn",
    "@typescript-eslint/prefer-nullish-coalescing": "warn",
    "@typescript-eslint/no-empty-function": "warn",
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/consistent-type-imports": "warn",

    // ── React ───────────────────────────────────────────
    "react/prop-types": "off",
    "react/react-in-jsx-scope": "off", // React 17+
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
    "react/no-array-index-key": "warn",

    // ── General ─────────────────────────────────────────
    "no-console": ["warn", { allow: ["warn", "error"] }],
    "eqeqeq": ["warn", "always"],
    "prefer-const": "warn",
    "no-var": "error",
  },
};
