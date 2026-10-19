import { describe, expect, it } from "vitest";

import { readWebhookRequest } from "./webhook-request";

describe("readWebhookRequest", () => {
  it("keeps the raw body byte-for-byte for signature checks", async () => {
    const rawBody = '{ "a":1,  "b":"é" }\n';
    const request = new Request("https://app.example/hook", { method: "POST", body: rawBody });
    expect((await readWebhookRequest(request)).rawBody).toBe(rawBody);
  });

  it("lower-cases header names and collects the query string", async () => {
    const request = new Request("https://app.example/hook?token=abc&x=1", {
      method: "POST",
      body: "{}",
      headers: { "X-Signature": "sig", "Content-Type": "application/json" },
    });
    const { headers, query } = await readWebhookRequest(request);
    expect(headers["x-signature"]).toBe("sig");
    expect(headers["content-type"]).toBe("application/json");
    expect(query).toEqual({ token: "abc", x: "1" });
  });
});
