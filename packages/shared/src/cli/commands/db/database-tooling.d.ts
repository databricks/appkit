// `shared` must not depend on `appkit`, so this only makes the dynamic import
// resolve. Its type is DatabaseTooling in ./tooling-contract.ts, which appkit's
// typecheck checks against the real exports.
declare module "@databricks/appkit/database-tooling";
