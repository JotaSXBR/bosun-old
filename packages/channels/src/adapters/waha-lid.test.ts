import { describe, expect, it } from "vitest";

import { wahaToInbound } from "./waha-payloads";

const message = (from: string, senderAlt?: string | null) => ({
  id: "false_x_1",
  from,
  body: "oi",
  timestamp: 1,
  _data: { Info: { SenderAlt: senderAlt } },
});

describe("wahaToInbound identity", () => {
  it("resolves an @lid sender to the phone, dropping the device suffix", () => {
    const { from } = wahaToInbound(
      message("16449842241553@lid", "5516997524950:53@s.whatsapp.net"),
    );
    expect(from).toEqual({ channelUserId: "5516997524950@c.us", lid: "16449842241553@lid" });
  });

  it("accepts a SenderAlt without a device suffix", () => {
    const { from } = wahaToInbound(message("16449842241553@lid", "5516997524950@s.whatsapp.net"));
    expect(from.channelUserId).toBe("5516997524950@c.us");
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["not a phone jid", "abc:1@s.whatsapp.net"],
    ["leading zero", "0516997524950:1@s.whatsapp.net"],
    ["too short", "1234567:1@s.whatsapp.net"],
    ["wrong server", "5516997524950:1@lid"],
  ])("keeps the lid when SenderAlt is %s", (_label, senderAlt) => {
    const { from } = wahaToInbound(message("16449842241553@lid", senderAlt));
    expect(from).toEqual({ channelUserId: "16449842241553@lid" });
  });

  it("never rewrites a sender that already is a phone", () => {
    const { from } = wahaToInbound(message("5511999888777@c.us", "5516997524950:1@s.whatsapp.net"));
    expect(from).toEqual({ channelUserId: "5511999888777@c.us" });
  });
});

describe("wahaToInbound display name", () => {
  it("bounds a sender-controlled name", () => {
    const { from } = wahaToInbound({
      ...message("5511999888777@c.us"),
      notifyName: `  ${"x".repeat(500)}  `,
    });
    expect(from.displayName).toHaveLength(120);
  });
});
