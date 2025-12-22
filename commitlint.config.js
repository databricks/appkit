export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "scope-enum": [
      1,
      "always",
      [
        "appkit", // @databricks/appkit
        "appkit-ui", // @databricks/appkit-ui
        "shared", // shared package
        "playground", // dev-playground app
        "docs", // documentation
        "deps", // dependency updates
        "release", // release commits
      ],
    ],
  },
};
