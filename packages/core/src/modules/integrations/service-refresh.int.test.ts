// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import type { Database } from "@crm/db";
import { beforeAll, describe, expect, it } from "vitest";

import { decryptJson } from "../../lib/crypto";
import { refreshConnectionStatus, requestConnectionPairingCode } from "./service";
import type { Stub } from "./service.fixture";
import { startWahaStub, useIntegrationsFixture } from "./service.fixture";

const fx = useIntegrationsFixture();
const { ctx, createWahaConnection } = fx;

let db: Database;
let stub: Stub;

// Runs after the fixture's own hooks, which create them.
beforeAll(() => {
  db = fx.db();
  stub = fx.stub();
});

describe("refreshConnectionStatus (WAHA connect)", () => {
  it("registers the session webhook and reports connected + paired phone", async () => {
    const conn = await createWahaConnection(stub.url);
    const result = await refreshConnectionStatus(db, ctx("owner"), conn.id);

    expect(result.status).toBe("connected");
    expect(result.connection.externalRef).toBe("5511999998888");

    // The session update carried the full webhook config — per-connection
    // URL, all subscribed events and the generated HMAC key.
    const session = decryptJson<{ session: string; webhookHmacKey: string }>(
      conn.credentialsEncrypted,
    );
    const put = stub.requests.find(
      (r) => r.method === "PUT" && r.path === `/api/sessions/${session.session}`,
    );
    expect(put).toBeDefined();
    const body = put!.body as {
      config: { webhooks: { url: string; events: string[]; hmac?: { key: string } }[] };
    };
    expect(body.config.webhooks).toHaveLength(1);
    const hook = body.config.webhooks[0]!;
    expect(hook.url).toBe(`https://app.test/api/webhooks/channels/${conn.webhookToken}`);
    expect(hook.hmac?.key).toBe(session.webhookHmacKey);
    expect(hook.events).toEqual(
      expect.arrayContaining([
        "message",
        "message.ack",
        "message.reaction",
        "message.edited",
        "message.revoked",
        "session.status",
        "presence.update",
      ]),
    );
  });

  it("returns the QR code while the session waits for a scan", async () => {
    const scanStub = await startWahaStub("SCAN_QR_CODE");
    try {
      const conn = await createWahaConnection(scanStub.url);
      const result = await refreshConnectionStatus(db, ctx("owner"), conn.id);
      expect(result.status).toBe("connecting");
      expect(result.qrCode?.mimeType).toBe("image/png");
      expect(typeof result.qrCode?.data).toBe("string");
    } finally {
      await scanStub.close();
    }
  });

  it("does not rewrite config mid-pairing (PUT restarts the session)", async () => {
    const scanStub = await startWahaStub("SCAN_QR_CODE");
    try {
      const conn = await createWahaConnection(scanStub.url);
      scanStub.requests.length = 0;
      const result = await refreshConnectionStatus(db, ctx("owner"), conn.id);
      expect(result.status).toBe("connecting");
      expect(result.qrCode?.mimeType).toBe("image/png");
      expect(scanStub.requests.some((r) => r.method === "PUT")).toBe(false);
    } finally {
      await scanStub.close();
    }
  });

  it("skips the config PUT when our webhook is already registered", async () => {
    const conn = await createWahaConnection(stub.url);
    stub.webhookUrl = `https://app.test/api/webhooks/channels/${conn.webhookToken}`;
    try {
      stub.requests.length = 0;
      const result = await refreshConnectionStatus(db, ctx("owner"), conn.id);
      expect(result.status).toBe("connected");
      expect(stub.requests.some((r) => r.method === "PUT")).toBe(false);
    } finally {
      stub.webhookUrl = undefined;
    }
  });

  it("issues a pairing code for a phone number", async () => {
    const conn = await createWahaConnection(stub.url);
    const { code } = await requestConnectionPairingCode(db, ctx("owner"), {
      id: conn.id,
      phoneNumber: "5511999998888",
    });
    expect(code).toBe("ABCD-EFGH");
    const request = stub.requests.find((r) => r.path.endsWith("/auth/request-code"));
    expect(request?.body).toEqual({ phoneNumber: "5511999998888" });
  });
});
