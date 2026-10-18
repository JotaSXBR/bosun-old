import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { RawWebhookRequest } from "../domain";
import metaFixtures from "./__fixtures__/meta-webhooks.json";
import { MetaCloudChannelProvider } from "./meta-cloud";
import { mockFetch } from "./test-utils";

describe("MetaCloudChannelProvider", () => {
  const metaConfig = {
    phoneNumberId: "pn-1",
    accessToken: "tok",
    appSecret: "app-secret",
    verifyToken: "verify-me",
    graphApiVersion: "v26.0",
  };

  function metaRequest(payload: unknown, secret = "app-secret"): RawWebhookRequest {
    const rawBody = JSON.stringify(payload);
    const sig = createHmac("sha256", secret).update(rawBody).digest("hex");
    return { rawBody, headers: { "x-hub-signature-256": `sha256=${sig}` }, query: {} };
  }

  it("sends text with messaging_product and Bearer auth", async () => {
    const { fetch: fetchImpl, calls } = mockFetch(() => ({
      json: { messages: [{ id: "wamid.1" }] },
    }));
    const provider = new MetaCloudChannelProvider(metaConfig, { fetch: fetchImpl });
    const result = await provider.sendMessage({
      to: "5511999999999",
      content: { type: "text", text: "hi" },
    });
    expect(result.externalId).toBe("wamid.1");
    const call = calls[0];
    expect(call?.url).toBe("https://graph.facebook.com/v26.0/pn-1/messages");
    expect(call?.init?.headers?.Authorization).toBe("Bearer tok");
    expect(JSON.parse(call?.init?.body ?? "{}")).toMatchObject({
      messaging_product: "whatsapp",
      to: "5511999999999",
      type: "text",
      text: { body: "hi" },
    });
  });

  it("sends media via provider media id", async () => {
    const { fetch: fetchImpl, calls } = mockFetch(() => ({ json: { messages: [{ id: "w" }] } }));
    const provider = new MetaCloudChannelProvider(metaConfig, { fetch: fetchImpl });
    await provider.sendMessage({
      to: "1",
      content: {
        type: "media",
        mediaKind: "document",
        source: { type: "provider", id: "media-id" },
        filename: "f.pdf",
      },
    });
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toMatchObject({
      type: "document",
      document: { id: "media-id", filename: "f.pdf" },
    });
  });

  it("verifies x-hub-signature-256 and rejects bad signatures", () => {
    const provider = new MetaCloudChannelProvider(metaConfig);
    expect(provider.verifyWebhook(metaRequest(metaFixtures.textMessage))).toBe(true);
    expect(provider.verifyWebhook(metaRequest(metaFixtures.textMessage, "other"))).toBe(false);
    expect(provider.verifyWebhook({ rawBody: "{}", headers: {}, query: {} })).toBe(false);
  });

  it("answers the verification challenge only for matching verify token", () => {
    const provider = new MetaCloudChannelProvider(metaConfig);
    expect(
      provider.verificationChallenge({
        "hub.mode": "subscribe",
        "hub.verify_token": "verify-me",
        "hub.challenge": "12345",
      }),
    ).toBe("12345");
    expect(
      provider.verificationChallenge({
        "hub.mode": "subscribe",
        "hub.verify_token": "wrong",
        "hub.challenge": "12345",
      }),
    ).toBeNull();
    // Same-length near-miss still fails (timing-safe compare path).
    expect(
      provider.verificationChallenge({
        "hub.mode": "subscribe",
        "hub.verify_token": "verify-mf",
        "hub.challenge": "12345",
      }),
    ).toBeNull();
  });

  it("parses text, media and status payloads", () => {
    const provider = new MetaCloudChannelProvider(metaConfig);
    const [msg] = provider.parseWebhook(metaRequest(metaFixtures.textMessage));
    expect(msg).toMatchObject({
      type: "message.received",
      externalMessageId: "wamid.HBgMNTUx...",
      from: { channelUserId: "5511999999999" },
      content: { type: "text", text: "Hi there" },
    });
    const [img] = provider.parseWebhook(metaRequest(metaFixtures.imageMessage));
    expect(img).toMatchObject({
      type: "message.received",
      content: {
        type: "media",
        mediaKind: "image",
        source: { type: "provider", id: "media-id-1" },
        caption: "look",
      },
    });
    const [status] = provider.parseWebhook(metaRequest(metaFixtures.statusRead));
    expect(status).toMatchObject({ type: "message.status", status: "read" });
  });
});
