export function isRemoteServerEnabled() {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.DISABLE_REMOTE_SERVING !== "true"
  );
}
