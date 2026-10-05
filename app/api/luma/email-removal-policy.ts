export function removalCanConfirm(env: Record<string, string | undefined> = process.env) {
  return env.EMAIL_REMOVAL_ENABLED === "true" && env.NODE_ENV === "production"
    && (env.RAILWAY_ENVIRONMENT_NAME ?? env.GUESTBOOK_ENVIRONMENT) === "production";
}
export function removalCanPreview(env: Record<string, string | undefined> = process.env) {
  return env.NODE_ENV === "development" || env.EMAIL_REMOVAL_ENABLED === "true";
}
export function requireRemovalProduction() {
  if (!removalCanConfirm()) throw Object.assign(new Error("Removal is available only in production. You can review the preview here."), {status:403, publicMessage:true});
}
