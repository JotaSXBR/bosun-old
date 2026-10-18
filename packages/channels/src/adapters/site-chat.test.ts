import { describe, expect, it } from "vitest";

import type { RawWebhookRequest } from "../domain";
import { createChannelProvider } from "../registry";
import { SiteChatChannelProvider } from "./site-chat";

function request(body: unknown): RawWebhookRequest {
  return { rawBody: JSON.stringify(body), headers: {}, query: {} };
}

const validBody = {
  sessionToken: "tok-1",
  text: "olá",
  clientMessageId: "c-1",
  from: { channelUserId: "v@site.dev", displayName: "Visitante" },
};

describe("SiteChatChannelProvider", () => {
  const provider = new SiteChatChannelProvider();

  it("is registered under site_chat", () => {
    expect(createChannelProvider({ kind: "site_chat" }).kind).toBe("site_chat");
  });

  it("connects immediately with no pairing", async () => {
    expect(provider.capabilities).toEqual({ qrCodeConnect: false, media: false });
    await expect(provider.connect()).resolves.toEqual({ status: "connected" });
    await expect(provider.getConnectionStatus()).resolves.toBe("connected");
  });

  it("verifyWebhook accepts only a valid inbound body", () => {
    expect(provider.verifyWebhook(request(validBody))).toBe(true);
    expect(provider.verifyWebhook(request({ ...validBody, text: "" }))).toBe(false);
    expect(provider.verifyWebhook(request({ ...validBody, sessionToken: "" }))).toBe(false);
    expect(provider.verifyWebhook({ rawBody: "not json", headers: {}, query: {} })).toBe(false);
  });

  it("parseWebhook normalizes into message.received", () => {
    const [event] = provider.parseWebhook(request(validBody));
    expect(event).toMatchObject({
      type: "message.received",
      externalMessageId: "c-1",
      from: { channelUserId: "v@site.dev", displayName: "Visitante" },
      content: { type: "text", text: "olá" },
    });
  });

  it("parseWebhook generates an id when clientMessageId is absent", () => {
    const { clientMessageId: _omit, ...body } = validBody;
    const [event] = provider.parseWebhook(request(body));
    expect(event?.type).toBe("message.received");
    const id = event?.type === "message.received" ? event.externalMessageId : undefined;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("sendMessage is a no-op success for text and rejects media", async () => {
    await expect(
      provider.sendMessage({ to: "conv-1", content: { type: "text", text: "oi" } }),
    ).resolves.toMatchObject({ status: "sent" });
    await expect(
      provider.sendMessage({
        to: "conv-1",
        content: {
          type: "media",
          mediaKind: "image",
          source: { type: "url", url: "https://x/img.png" },
        },
      }),
    ).rejects.toThrow("text only");
  });
});
