// WAHA chat features — webhook parsing (reaction/edited/revoked/presence)
// and the outbound chat surface (seen, presence, reaction, edit, delete,
// media download, reply_to, voice notes).
import { describe, expect, it } from "vitest";

import { mockFetch, wahaRequest } from "./test-utils";
import { WahaChannelProvider } from "./waha";

const wahaConfig = {
  baseUrl: "https://waha.example.com/",
  apiKey: "key-1",
  session: "default",
  webhookHmacKey: "hmac-secret",
};

const provider = (fetch?: ReturnType<typeof mockFetch>["fetch"]) =>
  new WahaChannelProvider(wahaConfig, fetch ? { fetch } : undefined);

describe("WahaChannelProvider — chat event parsing", () => {
  it("parses message.reaction with emoji and full message id", () => {
    const req = wahaRequest({
      event: "message.reaction",
      session: "default",
      payload: {
        id: "false_7911@c.us_REACTION_ID",
        from: "7911@c.us",
        fromMe: false,
        participant: "7911@c.us",
        reaction: { text: "🙏", messageId: "true_7911@c.us_MSG1" },
      },
    });
    expect(provider().parseWebhook(req)).toEqual([
      {
        type: "message.reaction",
        messageExternalId: "true_7911@c.us_MSG1",
        emoji: "🙏",
        actorChannelUserId: "7911@c.us",
        fromMe: false,
      },
    ]);
  });

  it("parses reaction removal (empty text) and our own reactions", () => {
    const req = wahaRequest({
      event: "message.reaction",
      session: "default",
      payload: {
        id: "true_7911@c.us_REACTION_ID",
        from: "7911@c.us",
        fromMe: true,
        reaction: { text: "", messageId: "false_7911@c.us_MSG2" },
      },
    });
    expect(provider().parseWebhook(req)).toEqual([
      expect.objectContaining({
        type: "message.reaction",
        messageExternalId: "false_7911@c.us_MSG2",
        emoji: "",
        fromMe: true,
      }),
    ]);
  });

  it("parses message.edited into candidate external ids", () => {
    const req = wahaRequest({
      event: "message.edited",
      session: "default",
      payload: {
        id: "false_7911@c.us_EDIT_ACTION",
        editedMessageId: "MSG1",
        body: "new text",
      },
    });
    expect(provider().parseWebhook(req)).toEqual([
      {
        type: "message.edited",
        messageExternalIds: ["true_7911@c.us_MSG1", "false_7911@c.us_MSG1"],
        newText: "new text",
      },
    ]);
  });

  it("parses message.revoked from the before.id", () => {
    const req = wahaRequest({
      event: "message.revoked",
      session: "default",
      payload: {
        before: { id: "false_7911@c.us_MSG9", body: "hi" },
        after: { id: "false_7911@c.us_MSG9", body: "" },
      },
    });
    expect(provider().parseWebhook(req)).toEqual([
      { type: "message.revoked", messageExternalId: "false_7911@c.us_MSG9" },
    ]);
  });

  it("parses presence.update into contact.presence per participant", () => {
    const req = wahaRequest({
      event: "presence.update",
      session: "default",
      payload: {
        id: "7911@c.us",
        presences: [
          { participant: "7911@c.us", lastKnownPresence: "typing" },
          { participant: "7911@c.us", lastKnownPresence: "bogus" },
        ],
      },
    });
    expect(provider().parseWebhook(req)).toEqual([
      {
        type: "contact.presence",
        chatId: "7911@c.us",
        participant: "7911@c.us",
        presence: "typing",
      },
    ]);
  });
});

describe("WahaChannelProvider — chat actions", () => {
  it("sendSeen posts to /api/sendSeen", async () => {
    const { fetch: fetchImpl, calls } = mockFetch(() => ({ json: {} }));
    await provider(fetchImpl).sendSeen("7911@c.us");
    expect(calls[0]?.url).toBe("https://waha.example.com/api/sendSeen");
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toEqual({
      session: "default",
      chatId: "7911@c.us",
    });
  });

  it("sendPresence posts chat presence to /api/{session}/presence", async () => {
    const { fetch: fetchImpl, calls } = mockFetch(() => ({ json: {} }));
    await provider(fetchImpl).sendPresence("7911@c.us", "recording");
    expect(calls[0]?.url).toBe("https://waha.example.com/api/default/presence");
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toEqual({
      chatId: "7911@c.us",
      presence: "recording",
    });
  });

  it("subscribePresence hits the per-chat subscribe endpoint", async () => {
    const { fetch: fetchImpl, calls } = mockFetch(() => ({ json: {} }));
    await provider(fetchImpl).subscribePresence("7911@c.us");
    expect(calls[0]?.url).toBe(
      "https://waha.example.com/api/default/presence/7911%40c.us/subscribe",
    );
  });

  it("sendReaction puts the emoji; empty string removes", async () => {
    const { fetch: fetchImpl, calls } = mockFetch(() => ({ json: {} }));
    const p = provider(fetchImpl);
    await p.sendReaction("true_7911@c.us_MSG1", "👍");
    await p.sendReaction("true_7911@c.us_MSG1", "");
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(calls[0]?.url).toBe("https://waha.example.com/api/reaction");
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toMatchObject({
      messageId: "true_7911@c.us_MSG1",
      reaction: "👍",
    });
    expect(JSON.parse(calls[1]?.init?.body ?? "{}")).toMatchObject({ reaction: "" });
  });

  it("editMessage and deleteMessage hit the chat message endpoints", async () => {
    const { fetch: fetchImpl, calls } = mockFetch(() => ({ json: {} }));
    const p = provider(fetchImpl);
    await p.editMessage("7911@c.us", "true_7911@c.us_MSG1", "edited");
    await p.deleteMessage("7911@c.us", "true_7911@c.us_MSG1");
    expect(calls[0]?.url).toBe(
      "https://waha.example.com/api/default/chats/7911%40c.us/messages/true_7911%40c.us_MSG1",
    );
    expect(calls[0]?.init?.method).toBe("PUT");
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toEqual({ text: "edited" });
    expect(calls[1]?.url).toBe(calls[0]?.url);
    expect(calls[1]?.init?.method).toBe("DELETE");
  });
});

describe("WahaChannelProvider — reply and voice notes", () => {
  it("adds reply_to when replyToId is set", async () => {
    const { fetch: fetchImpl, calls } = mockFetch(() => ({ json: { id: "m1" } }));
    await provider(fetchImpl).sendMessage({
      to: "7911@c.us",
      content: { type: "text", text: "ok" },
      replyToId: "false_7911@c.us_ORIG",
    });
    expect(JSON.parse(calls[0]?.init?.body ?? "{}")).toMatchObject({
      reply_to: "false_7911@c.us_ORIG",
    });
  });

  it("voiceNote audio routes to sendVoice with convert and ogg target", async () => {
    const { fetch: fetchImpl, calls } = mockFetch(() => ({ json: { id: "m2" } }));
    await provider(fetchImpl).sendMessage({
      to: "7911@c.us",
      content: {
        type: "media",
        mediaKind: "audio",
        voiceNote: true,
        source: { type: "url", url: "https://cdn.example.com/a.webm" },
        mimeType: "audio/webm;codecs=opus",
        filename: "audio.webm",
      },
    });
    expect(calls[0]?.url).toBe("https://waha.example.com/api/sendVoice");
    const body = JSON.parse(calls[0]?.init?.body ?? "{}") as {
      convert?: boolean;
      file?: { mimetype?: string; filename?: string };
    };
    expect(body.convert).toBe(true);
    // The payload describes the converted target, not the webm source.
    expect(body.file?.mimetype).toBe("audio/ogg; codecs=opus");
    expect(body.file?.filename).toBe("audio.ogg");
  });

  it("voiceNote without a filename falls back to voice.ogg", async () => {
    const { fetch: fetchImpl, calls } = mockFetch(() => ({ json: { id: "m3" } }));
    await provider(fetchImpl).sendMessage({
      to: "7911@c.us",
      content: {
        type: "media",
        mediaKind: "audio",
        voiceNote: true,
        source: { type: "url", url: "https://cdn.example.com/a" },
        mimeType: "audio/webm;codecs=opus",
      },
    });
    const body = JSON.parse(calls[0]?.init?.body ?? "{}") as { file?: { filename?: string } };
    expect(body.file?.filename).toBe("voice.ogg");
  });

  it("fetchContactAvatar downloads the CDN url without the api key", async () => {
    const { fetch: fetchImpl, calls } = mockFetch((url) =>
      url.startsWith("https://waha.example.com")
        ? { json: { profilePictureURL: "https://pps.whatsapp.net/abc.jpg" } }
        : { json: {} },
    );
    const avatar = await provider(fetchImpl).fetchContactAvatar("7911@c.us");
    expect(avatar).not.toBeNull();
    expect(calls[0]?.url).toContain("/api/contacts/profile-picture");
    expect(calls[0]?.init?.headers?.["X-Api-Key"]).toBe("key-1");
    // CDN hop is anonymous — never send the WAHA key off-host.
    expect(calls[1]?.url).toBe("https://pps.whatsapp.net/abc.jpg");
    expect(calls[1]?.init).toBeUndefined();
  });

  it("fetchContactAvatar returns null when the contact has no photo", async () => {
    const { fetch: fetchImpl } = mockFetch(() => ({
      json: { profilePictureURL: null },
    }));
    expect(await provider(fetchImpl).fetchContactAvatar("7911@c.us")).toBeNull();
  });

  it("plain audio still goes through sendFile", async () => {
    const { fetch: fetchImpl, calls } = mockFetch(() => ({ json: { id: "m3" } }));
    await provider(fetchImpl).sendMessage({
      to: "7911@c.us",
      content: {
        type: "media",
        mediaKind: "audio",
        source: { type: "url", url: "https://cdn.example.com/a.mp3" },
        mimeType: "audio/mpeg",
      },
    });
    expect(calls[0]?.url).toBe("https://waha.example.com/api/sendFile");
  });

  it("maps inbound media kind from the mimetype", () => {
    const req = wahaRequest({
      event: "message",
      session: "default",
      payload: {
        id: "false_7911@c.us_M1",
        from: "7911@c.us",
        hasMedia: true,
        mimetype: "audio/ogg; codecs=opus",
        mediaUrl: "http://waha/api/files/x.ogg",
        timestamp: 1700000000,
      },
    });
    const [event] = provider().parseWebhook(req);
    if (event?.type !== "message.received") throw new Error("expected message.received");
    expect(event.content).toMatchObject({ mediaKind: "audio" });
  });
});
