function invalid() { return Object.assign(new Error("Invalid storage configuration"), { code: "INVALID_STORAGE_CONFIGURATION" }); }

export function readStorageConfig(env = process.env) {
  const mode = env.STORAGE_MODE ?? "local";
  const localRoot = env.LOCAL_OBJECT_STORAGE_ROOT ?? "../.local/evidence";
  if (!["local", "s3"].includes(mode) || typeof localRoot !== "string" || !localRoot.trim()) throw invalid();
  const forcePathStyle = env.STORAGE_FORCE_PATH_STYLE ?? "false";
  if (!["true", "false"].includes(forcePathStyle)) throw invalid();
  const config = {
    mode, localRoot, bucket: env.STORAGE_BUCKET, endpoint: env.STORAGE_ENDPOINT || undefined,
    accessKeyId: env.STORAGE_ACCESS_KEY, secretAccessKey: env.STORAGE_SECRET_KEY,
    region: env.STORAGE_REGION || "auto", forcePathStyle: forcePathStyle === "true",
  };
  if (mode === "s3") {
    if (typeof config.bucket !== "string" || !config.bucket.trim()
        || Boolean(config.accessKeyId) !== Boolean(config.secretAccessKey)) throw invalid();
    if (config.endpoint) {
      let url;
      try { url = new URL(config.endpoint); } catch { throw invalid(); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw invalid();
    }
  }
  return Object.freeze(config);
}
