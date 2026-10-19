import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getServerEnv, isConfigured, resetServerEnvCache } from "./index";

const REQUIRED_ENV = {
  NODE_ENV: "test",
  APP_URL: "http://localhost:3000",
  DATABASE_URL: "postgres://crm_app:crm_app@localhost:5432/crm",
  BETTER_AUTH_SECRET: "x".repeat(32),
};

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  resetServerEnvCache();
});

afterEach(() => {
  process.env = saved;
  resetServerEnvCache();
});

describe("getServerEnv", () => {
  it("parses with only the required vars", () => {
    process.env = { ...REQUIRED_ENV };
    const env = getServerEnv();
    expect(env.nodeEnv).toBe("test");
    expect(env.appUrl).toBe("http://localhost:3000");
    expect(env.database.url).toBe(REQUIRED_ENV.DATABASE_URL);
    expect(env.database.adminUrl).toBeUndefined();
    expect(env.email.provider).toBe("console");
    expect(env.whatsapp.meta.graphApiVersion).toBe("v26.0");
    expect(env.billing.asaasEnvironment).toBe("sandbox");
  });

  it("treats empty strings as undefined", () => {
    process.env = { ...REQUIRED_ENV, REDIS_URL: "", OPENAI_API_KEY: "" };
    const env = getServerEnv();
    expect(env.redis.url).toBeUndefined();
    expect(env.ai.openaiApiKey).toBeUndefined();
    expect(isConfigured(env, "redis")).toBe(false);
  });

  it("throws listing invalid vars when required vars are missing", () => {
    process.env = { NODE_ENV: "test" };
    expect(() => getServerEnv()).toThrowError(/Invalid environment variables/);
    expect(() => getServerEnv()).toThrowError(/APP_URL/);
    expect(() => getServerEnv()).toThrowError(/DATABASE_URL/);
    expect(() => getServerEnv()).toThrowError(/BETTER_AUTH_SECRET/);
  });

  it("rejects a short BETTER_AUTH_SECRET", () => {
    process.env = { ...REQUIRED_ENV, BETTER_AUTH_SECRET: "short" };
    expect(() => getServerEnv()).toThrowError(/BETTER_AUTH_SECRET/);
  });

  it("reports configured integration groups", () => {
    process.env = {
      ...REQUIRED_ENV,
      WAHA_BASE_URL: "http://localhost:3001",
      WAHA_API_KEY: "key",
      STORAGE_S3_ENDPOINT: "http://localhost:9000",
      STORAGE_S3_BUCKET: "crm",
      STORAGE_S3_ACCESS_KEY_ID: "id",
      STORAGE_S3_SECRET_ACCESS_KEY: "secret",
    };
    const env = getServerEnv();
    expect(isConfigured(env, "waha")).toBe(true);
    expect(isConfigured(env, "storage")).toBe(true);
    expect(isConfigured(env, "meta")).toBe(false);
    expect(isConfigured(env, "billing")).toBe(false);
  });
});
