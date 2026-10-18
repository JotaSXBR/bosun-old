import { describe, expect, it } from "vitest";

import { pickProfileMetadata } from "./contact-profile";

describe("pickProfileMetadata", () => {
  it("keeps profile keys and drops google mirror state and provider extras", () => {
    expect(
      pickProfileMetadata({
        email: "a@b.co",
        urls: ["https://x.test"],
        google: { resourceName: "people/1", etag: "e" },
        avatarKey: "k",
      }),
    ).toEqual({ email: "a@b.co", urls: ["https://x.test"] });
  });
});
