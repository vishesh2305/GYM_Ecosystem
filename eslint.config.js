import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**", "**/.turbo/**"] },
  ...tseslint.configs.strict,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { ignoreRestSiblings: true, argsIgnorePattern: "^_" },
      ],
      // Nest modules are decorator-only classes.
      "@typescript-eslint/no-extraneous-class": ["error", { allowWithDecorator: true }],
    },
  },
);
