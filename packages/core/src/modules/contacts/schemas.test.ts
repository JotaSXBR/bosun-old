import { describe, expect, it } from "vitest";

import { updateContactProfileInput } from "./schemas";

const contactId = "0190b1a0-0000-7000-8000-000000000001";
const parse = (patch: Record<string, unknown>) =>
  updateContactProfileInput.safeParse({ contactId, ...patch });

describe("updateContactProfileInput — profile fields", () => {
  it("accepts a full profile", () => {
    const result = parse({
      company: "Acme Ltda",
      jobTitle: "Diretora",
      address: "Rua A, 10\nSão Paulo - SP",
      birthday: "1990-02-28",
      urls: ["https://acme.test", "http://acme.test/sobre"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty values, which clear the field", () => {
    const result = parse({ company: "", jobTitle: "", address: "", birthday: "", urls: [] });
    expect(result.success).toBe(true);
  });

  it.each(["javascript:alert(1)", "data:text/html,x", "ftp://acme.test", "acme.test", ""])(
    "rejects the url %j",
    (url) => {
      expect(parse({ urls: [url] }).success).toBe(false);
    },
  );

  it("rejects more than 5 urls and urls over 300 chars", () => {
    const six = Array.from({ length: 6 }, (_, i) => `https://acme.test/${i}`);
    expect(parse({ urls: six }).success).toBe(false);
    expect(parse({ urls: [`https://acme.test/${"a".repeat(300)}`] }).success).toBe(false);
  });

  it.each(["2026-02-30", "26-1-1", "01/02/1990", "1990-13-01"])(
    "rejects the birthday %j",
    (birthday) => {
      expect(parse({ birthday }).success).toBe(false);
    },
  );

  it.each(["2024-02-29", "1900-01-01"])("accepts the birthday %j", (birthday) => {
    expect(parse({ birthday }).success).toBe(true);
  });

  it.each(["2023-02-29", "2026-04-31"])("rejects the impossible birthday %j", (birthday) => {
    expect(parse({ birthday }).success).toBe(false);
  });

  it.each([
    "https://user:pass@acme.test",
    "https://user@acme.test",
    "http://localhost:3000",
    "http://192.168.0.10/x",
  ])("rejects the unsafe or non-public site %j", (url) => {
    expect(parse({ urls: [url] }).success).toBe(false);
  });

  it("accepts a public site with path, query and a different port", () => {
    expect(parse({ urls: ["https://acme.test:8443/sobre?x=1#topo"] }).success).toBe(true);
  });

  it.each(["a\u0000b", "a\rb", "a\nb", "a\tb", "a\u202Eb", "a\u2066b", "a\u007Fb"])(
    "rejects control or bidi characters in single-line fields: %j",
    (value) => {
      for (const field of ["displayName", "company", "jobTitle", "phone"]) {
        expect(parse({ [field]: value }).success, field).toBe(false);
      }
    },
  );

  it("allows normal accents, emoji and RTL letters in single-line fields", () => {
    expect(
      parse({ displayName: "José da Conceição 🙂", company: "Ação & Cia", jobTitle: "שלום" })
        .success,
    ).toBe(true);
  });

  it("allows newlines and tabs in address and notes, but not other control or bidi chars", () => {
    expect(parse({ address: "Rua A\r\nSão Paulo\tSP", notes: "linha 1\nlinha 2" }).success).toBe(
      true,
    );
    for (const value of ["a\u0000b", "a\u202Eb", "a\u2067b", "a\u001Bb"]) {
      expect(parse({ address: value }).success).toBe(false);
      expect(parse({ notes: value }).success).toBe(false);
    }
  });

  it("explains the rejection in Portuguese", () => {
    const result = parse({ company: "a\u0000b" });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("caracteres");
  });

  it("enforces the length limits", () => {
    expect(parse({ company: "a".repeat(121) }).success).toBe(false);
    expect(parse({ jobTitle: "a".repeat(121) }).success).toBe(false);
    expect(parse({ address: "a".repeat(501) }).success).toBe(false);
  });
});
