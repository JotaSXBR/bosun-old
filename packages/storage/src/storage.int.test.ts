// Integration test against the local RustFS container (pnpm infra:up).
// Skips with a clear message when storage is not configured/reachable.
import { getServerEnv, isConfigured } from "@crm/config";
import { describe, expect, it } from "vitest";

import { StorageObjectNotFoundError } from "./domain";
import { tenantObjectKey } from "./keys";
import { S3StorageProvider } from "./s3";

function makeProvider(): S3StorageProvider | null {
  let env;
  try {
    env = getServerEnv();
  } catch {
    return null;
  }
  if (!isConfigured(env, "storage")) return null;
  return new S3StorageProvider({
    bucket: env.storage.bucket!,
    region: env.storage.region ?? "us-east-1",
    endpoint: env.storage.endpoint,
    forcePathStyle: env.storage.forcePathStyle,
    accessKeyId: env.storage.accessKeyId!,
    secretAccessKey: env.storage.secretAccessKey!,
  });
}

const provider = makeProvider();

describe.skipIf(!provider)("S3StorageProvider (RustFS integration)", () => {
  const key = tenantObjectKey(
    "018f8b9a-7c3d-7f2e-9a4b-1c2d3e4f5a6b",
    "tests",
    `int-${Date.now()}.txt`,
  );

  it("uploads, downloads and deletes an object", async () => {
    const storage = provider!;
    await storage.upload({ key, body: "hello rustfs", contentType: "text/plain" });
    const res = await storage.download(key);
    expect(new TextDecoder().decode(res.body)).toBe("hello rustfs");
    expect(res.contentType).toContain("text/plain");
    await storage.delete(key);
    await expect(storage.download(key)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
  });

  it("returns a signed GET url that can be fetched", async () => {
    const storage = provider!;
    await storage.upload({ key, body: "signed" });
    const url = await storage.getSignedUrl(key, {
      method: "get",
      expiresInSeconds: 60,
    });
    const res = await fetch(url);
    expect(res.ok).toBe(true);
    expect(await res.text()).toBe("signed");
    await storage.delete(key);
  });
});
