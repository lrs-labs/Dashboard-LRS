import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPagesRuntimeConfig, writePagesRuntimeConfig } from "../scripts/inject-pages-runtime-config.mjs";

const fixtureEnv = Object.freeze({
  LRS_SUPABASE_URL: "https://fixture-project.supabase.co",
  LRS_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic_test_key_only",
  LRS_PRIVATE_APP_ORIGIN: "https://fixture-pages.example"
});

test("Pages config injection uses only the three public browser settings", () => {
  assert.deepEqual(buildPagesRuntimeConfig(fixtureEnv), {
    enabled: true,
    supabaseUrl: fixtureEnv.LRS_SUPABASE_URL,
    publishableKey: fixtureEnv.LRS_SUPABASE_PUBLISHABLE_KEY,
    allowedOrigin: fixtureEnv.LRS_PRIVATE_APP_ORIGIN
  });
});

test("Pages config injection rejects non-HTTPS origins, malformed keys, and service keys", () => {
  for (const env of [
    { ...fixtureEnv, LRS_PRIVATE_APP_ORIGIN: "http://fixture-pages.example" },
    { ...fixtureEnv, LRS_SUPABASE_URL: "https://fixture-project.supabase.co/path" },
    { ...fixtureEnv, LRS_SUPABASE_PUBLISHABLE_KEY: "service_role_private_fixture" },
    { ...fixtureEnv, LRS_PRIVATE_APP_ORIGIN: "https://fixture-pages.example/path" }
  ]) assert.throws(() => buildPagesRuntimeConfig(env), { message: "pages_runtime_config_invalid" });
});

test("generated config is written atomically to an artifact directory, never the source root", async () => {
  const artifactDir = await mkdtemp(path.join(os.tmpdir(), "lrs-pages-artifact-"));
  try {
    const output = await writePagesRuntimeConfig(artifactDir, fixtureEnv);
    const contents = await readFile(output, "utf8");
    assert.match(output, /private-runtime-config\.js$/);
    assert.deepEqual(JSON.parse(contents.match(/Object\.freeze\((.*)\);/s)[1]), {
      enabled: true,
      supabaseUrl: fixtureEnv.LRS_SUPABASE_URL,
      publishableKey: fixtureEnv.LRS_SUPABASE_PUBLISHABLE_KEY,
      allowedOrigin: fixtureEnv.LRS_PRIVATE_APP_ORIGIN
    });
    await assert.rejects(writePagesRuntimeConfig(process.cwd(), fixtureEnv), { message: "artifact_directory_invalid" });
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});
