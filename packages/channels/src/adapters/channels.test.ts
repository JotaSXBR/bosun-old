import { describe, expect, it } from "vitest";

import type { ChannelProvider } from "../provider";
import { createChannelProvider } from "../registry";
import { FakeChannelProvider } from "../testing";
import wahaFixtures from "./__fixtures__/waha-webhooks.json";
import { mockFetch, wahaRequest } from "./test-utils";
import { WahaChannelProvider } from "./waha";

const wahaConfig = {
  baseUrl: "https://waha.example.com/",
  apiKey: "key-1",
  session: "default",
  webhookHmacKey: "hmac-secret",
};

describe("WahaChannelProvider", () => {
  it("sends text to /api/sendText with X-Api-Key and chatId", async () => {
    const { fetch: fetchImpl, calls } = mockFetch(() => ({ json: { id: "msg-1" } }));
    const provider = new WahaChannelProvider(wahaConfig, { fetch: fetchImpl });
    const result = await provider.sendMessage({
      to: "1234@c.us",
      content: { type: "text", text: "hello" },
    });
    expect(result).toEqual({ externalId: "msg-1", status: "sent" });
    const call = calls[0];
    expect(call?.url).toBe("https://waha.example.com/api/sendText");
    expect(call?.init?.headers?.["X-Api-Key"]).toBe("key-1");
    expect(JSON.parse(call?.init?.body ?? "{}")).toMatchObject({
      session: "default",
      chatId: "1234@c.us",
      text: "hello",
    });
  });

  it("sends to @lid chatIds verbatim — GOWS resolves the LID", async () => {
    const { fetch: fetchImpl, calls } = mockFetch(() => ({ json: { id: "msg-lid" } }));
    const provider = new WahaChannelProvider(wahaConfig, { fetch: fetchImpl });
    await provider.sendMessage({
      to: "16449842241553@lid",
      content: { type: "text", text: "oi" },
    });
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toMatchObject({
      chatId: "16449842241553@lid",
    });
  });

  it("sends media by URL to the kind-specific endpoint", async () => {
    const { fetch: fetchImpl, calls } = mockFetch(() => ({ json: { id: "m2" } }));
    const provider = new WahaChannelProvider(wahaConfig, { fetch: fetchImpl });
    await provider.sendMessage({
      to: "1234@c.us",
      content: {
        type: "media",
        mediaKind: "image",
        source: { type: "url", url: "https://cdn.example.com/a.png" },
        mimeType: "image/png",
        caption: "cap",
      },
    });
    expect(calls[0]?.url).toBe("https://waha.example.com/api/sendImage");
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toMatchObject({
      file: { url: "https://cdn.example.com/a.png", mimetype: "image/png" },
      caption: "cap",
    });
  });

  it("rejects provider-id media for WAHA", async () => {
    const { fetch: fetchImpl } = mockFetch(() => ({ json: {} }));
    const provider = new WahaChannelProvider(wahaConfig, { fetch: fetchImpl });
    await expect(
      provider.sendMessage({
        to: "x@c.us",
        content: { type: "media", mediaKind: "image", source: { type: "provider", id: "m1" } },
      }),
    ).rejects.toThrow(/URL/);
  });

  it("connects an existing working session and reports connected", async () => {
    const { fetch: fetchImpl } = mockFetch((url) => ({
      json: url.includes("/api/sessions/default") ? { name: "default", status: "WORKING" } : {},
    }));
    const provider = new WahaChannelProvider(wahaConfig, { fetch: fetchImpl });
    expect((await provider.connect()).status).toBe("connected");
    expect(await provider.getConnectionStatus()).toBe("connected");
  });

  it("creates the session when missing", async () => {
    let created = false;
    const { fetch: fetchImpl } = mockFetch((url, init) => {
      if (url.endsWith("/api/sessions/default") && !created) return { status: 404 };
      if (url.endsWith("/api/sessions") && init?.method === "POST") {
        created = true;
        return { json: { name: "default", status: "STARTING" } };
      }
      return { json: { name: "default", status: "STARTING" } };
    });
    const provider = new WahaChannelProvider(wahaConfig, { fetch: fetchImpl });
    expect((await provider.connect()).status).toBe("connecting");
    expect(created).toBe(true);
  });

  it("verifies webhook HMAC and rejects bad/missing signatures", () => {
    const provider = new WahaChannelProvider(wahaConfig);
    const req = wahaRequest(wahaFixtures.message, "hmac-secret");
    expect(provider.verifyWebhook(req)).toBe(true);
    expect(provider.verifyWebhook(wahaRequest(wahaFixtures.message, "wrong"))).toBe(false);
    expect(provider.verifyWebhook(wahaRequest(wahaFixtures.message))).toBe(false);
    // no key configured → mandatory verification fails
    expect(
      new WahaChannelProvider({ ...wahaConfig, webhookHmacKey: undefined }).verifyWebhook(req),
    ).toBe(false);
  });

  it("parses message/ack/session.status webhooks into domain events", () => {
    const provider = new WahaChannelProvider(wahaConfig);
    const [msg] = provider.parseWebhook(wahaRequest(wahaFixtures.message));
    expect(msg).toMatchObject({
      type: "message.received",
      externalMessageId: "false_1234567890@c.us_ABC123",
      from: { channelUserId: "1234567890@c.us", displayName: "Alice" },
      content: { type: "text", text: "Hello World!" },
    });
    expect(provider.parseWebhook(wahaRequest(wahaFixtures.messageFromMe))).toEqual([]);
    const [ack] = provider.parseWebhook(wahaRequest(wahaFixtures.ackDelivered));
    expect(ack).toMatchObject({ type: "message.status", status: "delivered" });
    const [failed] = provider.parseWebhook(wahaRequest(wahaFixtures.ackFailed));
    expect(failed).toMatchObject({ type: "message.status", status: "failed" });
    const [conn] = provider.parseWebhook(wahaRequest(wahaFixtures.sessionStatus));
    expect(conn).toMatchObject({ type: "connection.status", status: "connected" });
    expect(provider.parseWebhook(wahaRequest(wahaFixtures.unknown))).toEqual([]);
    expect(provider.parseWebhook({ rawBody: "not json", headers: {}, query: {} })).toEqual([]);
  });

  it("parses GOWS payloads — null fields, @lid identity, bare quoted/revoked ids", () => {
    const provider = new WahaChannelProvider(wahaConfig);
    const [msg] = provider.parseWebhook(wahaRequest(wahaFixtures.gowsMessage));
    expect(msg).toMatchObject({
      type: "message.received",
      externalMessageId: "false_16449842241553@lid_3EB001F893C4BA9DD928D4",
      from: { channelUserId: "16449842241553@lid", displayName: "Contato Teste" },
      content: { type: "text", text: "oi" },
    });
    const [media] = provider.parseWebhook(wahaRequest(wahaFixtures.gowsMediaMessage));
    expect(media).toMatchObject({
      type: "message.received",
      content: {
        type: "media",
        mediaKind: "document",
        mimeType: "application/pdf",
        filename: "contrato.pdf",
        source: { type: "url", url: "/api/media/3EB0D7524B890A7692C07C" },
      },
    });
    const [quoted] = provider.parseWebhook(wahaRequest(wahaFixtures.gowsQuotedMessage));
    expect(quoted).toMatchObject({
      type: "message.received",
      content: {
        type: "text",
        quotedExternalId: "false_16449842241553@lid_3EB001F893C4BA9DD928D4",
      },
    });
    const [revoked] = provider.parseWebhook(wahaRequest(wahaFixtures.gowsRevoked));
    expect(revoked).toMatchObject({
      type: "message.revoked",
      messageExternalId: "false_16449842241553@lid_3EB001F893C4BA9DD928D4",
    });
    const [reaction] = provider.parseWebhook(wahaRequest(wahaFixtures.gowsReaction));
    expect(reaction).toMatchObject({
      type: "message.reaction",
      messageExternalId: "false_16449842241553@lid_3EB001F893C4BA9DD928D4",
      emoji: "👍",
      actorChannelUserId: "16449842241553@lid",
    });
  });

  it("resolves relative media urls against the WAHA host and refuses foreign hosts", async () => {
    const { fetch: fetchImpl, calls } = mockFetch(() => ({ json: {} }));
    const provider = new WahaChannelProvider(wahaConfig, { fetch: fetchImpl });
    await provider.fetchMedia("/api/media/abc");
    expect(calls[0]?.url).toBe("https://waha.example.com/api/media/abc");
    await provider.fetchMedia("https://waha.example.com/api/media/def");
    expect(calls[1]?.url).toBe("https://waha.example.com/api/media/def");
    await expect(provider.fetchMedia("https://evil.example.com/api/media/x")).rejects.toThrow();
    // Prefix lookalikes must fail the origin check — X-Api-Key never leaves
    // the WAHA host.
    await expect(
      provider.fetchMedia("https://waha.example.com.evil.com/api/media/x"),
    ).rejects.toThrow();
    await expect(
      provider.fetchMedia("https://waha.example.com@evil.com/api/media/x"),
    ).rejects.toThrow();
    await expect(provider.fetchMedia("not a url")).rejects.toThrow();
  });
});

describe("createChannelProvider", () => {
  it("builds each kind through the registry", () => {
    expect(createChannelProvider({ kind: "waha", ...wahaConfig }).kind).toBe("waha");
    expect(
      createChannelProvider({
        kind: "meta_cloud",
        phoneNumberId: "p",
        accessToken: "t",
        appSecret: "s",
        verifyToken: "v",
      }).kind,
    ).toBe("meta_cloud");
  });
});

describe("FakeChannelProvider", () => {
  it("behaves as a ChannelProvider: connect, send, events", async () => {
    const provider: ChannelProvider = new FakeChannelProvider();
    expect((await provider.connect()).status).toBe("connected");
    await provider.sendMessage({ to: "x", content: { type: "text", text: "hi" } });
    const fake = provider as FakeChannelProvider;
    expect(fake.sentMessages).toHaveLength(1);
    fake.queuedEvents = [
      {
        type: "message.received",
        externalMessageId: "e1",
        from: { channelUserId: "u1" },
        content: { type: "text", text: "yo" },
        timestamp: new Date(0),
      },
    ];
    const events = provider.parseWebhook({ rawBody: "", headers: {}, query: {} });
    expect(events).toHaveLength(1);
    expect(provider.parseWebhook({ rawBody: "", headers: {}, query: {} })).toEqual([]);
    expect(await provider.getConnectionStatus()).toBe("connected");
    await provider.disconnect();
    expect(await provider.getConnectionStatus()).toBe("disconnected");
  });
});
