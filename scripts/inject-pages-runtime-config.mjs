import { randomUUID } from "node:crypto";
import { mkdir, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isSupabasePublishableKey } from "../private-auth-runtime.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function buildPagesRuntimeConfig(env = process.env) {
  const supabaseUrl = env.LRS_SUPABASE_URL || "";
  const publishableKey = env.LRS_SUPABASE_PUBLISHABLE_KEY || "";
  const allowedOrigin = env.LRS_PRIVATE_APP_ORIGIN || "";
  let projectUrl, siteOrigin;
  try { projectUrl = new URL(supabaseUrl); } catch (_) { throw new Error("pages_runtime_config_invalid"); }
  try { siteOrigin = new URL(allowedOrigin); } catch (_) { throw new Error("pages_runtime_config_invalid"); }

  if (projectUrl.protocol !== "https:" || projectUrl.username || projectUrl.password || projectUrl.search || projectUrl.hash ||
      projectUrl.origin !== supabaseUrl.replace(/\/$/, "") || !isSupabasePublishableKey(publishableKey) ||
      siteOrigin.protocol !== "https:" || siteOrigin.origin !== allowedOrigin || siteOrigin.pathname !== "/" || siteOrigin.search || siteOrigin.hash) {
    throw new Error("pages_runtime_config_invalid");
  }
  return Object.freeze({ enabled: true, supabaseUrl: projectUrl.origin, publishableKey, allowedOrigin: siteOrigin.origin });
}

export async function writePagesRuntimeConfig(artifactDirectory, env = process.env) {
  if (typeof artifactDirectory !== "string" || !artifactDirectory.trim()) throw new Error("artifact_directory_required");
  const resolvedDirectory = path.resolve(artifactDirectory);
  const canonicalDirectory = await realpath(resolvedDirectory).catch(() => null);
  const canonicalRoot = await realpath(projectRoot);
  if (!canonicalDirectory || canonicalDirectory === canonicalRoot) throw new Error("artifact_directory_invalid");
  const details = await stat(canonicalDirectory);
  if (!details.isDirectory()) throw new Error("artifact_directory_invalid");

  const config = buildPagesRuntimeConfig(env);
  const outputPath = path.join(canonicalDirectory, "private-runtime-config.js");
  const temporaryPath = path.join(canonicalDirectory, `.private-runtime-config-${randomUUID()}.tmp`);
  const contents = `globalThis.LRS_PUBLIC_RUNTIME_CONFIG = Object.freeze(${JSON.stringify(config)});\n`;
  try {
    await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o644, flag: "wx" });
    await rename(temporaryPath, outputPath);
  } catch (_) {
    await import("node:fs/promises").then(fs => fs.rm(temporaryPath, { force: true })).catch(() => {});
    throw new Error("pages_runtime_config_write_failed");
  }
  return outputPath;
}

async function main(argv) {
  const optionIndex = argv.indexOf("--artifact-dir");
  if (optionIndex < 0 || !argv[optionIndex + 1]) throw new Error("usage: --artifact-dir <directory>");
  await mkdir(path.resolve(argv[optionIndex + 1]), { recursive: true });
  const outputPath = await writePagesRuntimeConfig(argv[optionIndex + 1]);
  process.stdout.write(`Generated disabled-safe runtime config in artifact: ${path.basename(path.dirname(outputPath))}/${path.basename(outputPath)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message === "usage: --artifact-dir <directory>" ? error.message : "Pages runtime config generation failed."}\n`);
    process.exitCode = 1;
  });
}
