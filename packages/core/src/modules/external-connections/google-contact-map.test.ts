import { describe, expect, it } from "vitest";

import {
  isEligible,
  type MappableContact,
  payloadHash,
  personFields,
  toPerson,
} from "./google-contact-map";

const full: MappableContact = {
  channelUserId: "5511988887777@c.us",
  displayName: "Maria Souza",
  metadata: {
    source: "manual",
    email: "maria@example.com",
    phone: "+55 11 3333-4444",
    company: "Acme Ltda",
    jobTitle: "Diretora",
    address: "Rua A, 10\nSão Paulo - SP",
    birthday: "1990-02-28",
    notes: "VIP",
    urls: ["https://acme.test", "https://acme.test/sobre"],
    avatarKey: "org/x/contact-avatar/y",
    google: { resourceName: "people/c1" },
  },
};
const contact = (patch: Partial<MappableContact> = {}, meta: Record<string, unknown> = {}) => ({
  ...full,
  ...patch,
  metadata: { ...full.metadata, ...meta },
});

describe("toPerson", () => {
  it("maps every managed field to the People shape", () => {
    expect(toPerson(full)).toEqual({
      names: [{ unstructuredName: "Maria Souza" }],
      phoneNumbers: [{ value: "+5511988887777" }, { value: "+55 11 3333-4444" }],
      emailAddresses: [{ value: "maria@example.com" }],
      organizations: [{ name: "Acme Ltda", title: "Diretora" }],
      addresses: [{ formattedValue: "Rua A, 10\nSão Paulo - SP" }],
      biographies: [{ value: "VIP", contentType: "TEXT_PLAIN" }],
      birthdays: [{ date: { year: 1990, month: 2, day: 28 } }],
      urls: [{ value: "https://acme.test" }, { value: "https://acme.test/sobre" }],
    });
  });

  it("never sends photo, custom fields or sync state", () => {
    const keys = Object.keys(toPerson(full));
    expect(keys).not.toContain("photos");
    expect(keys).not.toContain("userDefined");
    expect(JSON.stringify(toPerson(full))).not.toMatch(/avatar|people\/c1|source/);
  });

  it("omits names when the contact has none (the Google name is left alone)", () => {
    expect(toPerson(contact({ displayName: null })).names).toBeUndefined();
    expect(toPerson(contact({ displayName: "   " })).names).toBeUndefined();
  });

  it("uses only a WhatsApp @c.us id as a phone — @lid is opaque, not a number", () => {
    const lid = contact({ channelUserId: "184467440737095@lid" }, { phone: "", email: "" });
    expect(toPerson(lid).phoneNumbers).toBeUndefined();
    const withExtra = contact(
      { channelUserId: "184467440737095@lid" },
      { phone: "+55 21 98888-0000" },
    );
    expect(toPerson(withExtra).phoneNumbers).toEqual([{ value: "+55 21 98888-0000" }]);
  });

  it("does not repeat the additional phone when it equals the channel phone", () => {
    expect(toPerson(contact({}, { phone: "+55 (11) 98888-7777" })).phoneNumbers).toEqual([
      { value: "+5511988887777" },
    ]);
  });

  it("builds organizations from company and/or title only", () => {
    expect(toPerson(contact({}, { jobTitle: "" })).organizations).toEqual([{ name: "Acme Ltda" }]);
    expect(toPerson(contact({}, { company: "" })).organizations).toEqual([{ title: "Diretora" }]);
    expect(toPerson(contact({}, { company: "", jobTitle: "" })).organizations).toBeUndefined();
  });

  it("keeps singleton fields to a single value", () => {
    const person = toPerson(full);
    expect(person.names).toHaveLength(1);
    expect(person.birthdays).toHaveLength(1);
    expect(person.biographies).toHaveLength(1);
  });

  it("drops an impossible or malformed birthday instead of failing the sync", () => {
    for (const birthday of ["2023-02-29", "1990-13-01", "31/12/1990", 19900228, null]) {
      expect(toPerson(contact({}, { birthday })).birthdays, String(birthday)).toBeUndefined();
    }
  });

  it("ignores non-string urls and caps the list at 5", () => {
    const urls = [
      "https://a.test",
      7,
      null,
      "https://b.test",
      "https://c.test",
      "https://d.test",
      "https://e.test",
      "https://f.test",
    ];
    expect(toPerson(contact({}, { urls })).urls).toHaveLength(5);
    expect(toPerson(contact({}, { urls: "https://a.test" })).urls).toBeUndefined();
  });

  it("skips empty strings and non-string values", () => {
    const person = toPerson(
      contact({}, { email: "", notes: "  ", address: 42, company: null, jobTitle: [] }),
    );
    expect(person.emailAddresses).toBeUndefined();
    expect(person.biographies).toBeUndefined();
    expect(person.addresses).toBeUndefined();
    expect(person.organizations).toBeUndefined();
  });
});

describe("isEligible", () => {
  it("accepts a WhatsApp phone or an e-mail", () => {
    expect(isEligible(full)).toBe(true);
    expect(isEligible(contact({ channelUserId: "visitor-abc" }))).toBe(true); // e-mail only (site chat)
  });

  it("rejects contacts with neither a phone number nor an e-mail", () => {
    const base = contact({ channelUserId: "184467440737095@lid" }, { email: "" });
    expect(isEligible(base)).toBe(false);
    expect(isEligible(contact({ channelUserId: "visitor-abc" }, { email: undefined }))).toBe(false);
    expect(isEligible(contact({ channelUserId: "123@c.us" }, { email: "" }))).toBe(false); // too short for E.164
  });
});

describe("payloadHash / personFields", () => {
  it("is stable for the same contact and changes with any mapped field", () => {
    const hash = payloadHash(toPerson(full));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadHash(toPerson({ ...full }))).toBe(hash);
    expect(payloadHash(toPerson(contact({}, { company: "Outra" })))).not.toBe(hash);
    expect(payloadHash(toPerson(contact({ displayName: "Maria S." })))).not.toBe(hash);
  });

  it("ignores data Bosun does not mirror (avatar, sync state, source)", () => {
    const hash = payloadHash(toPerson(full));
    expect(payloadHash(toPerson(contact({}, { avatarKey: "other", google: { etag: "e2" } })))).toBe(
      hash,
    );
  });

  it("lists only the fields present, so empty ones are never wiped in Google", () => {
    expect(personFields(toPerson(contact({ displayName: null }, { notes: "", urls: [] })))).toEqual(
      ["phoneNumbers", "emailAddresses", "organizations", "addresses", "birthdays"],
    );
  });
});

describe("toPerson sanitization (data that never went through the profile schema)", () => {
  it("drops a display name with bidi or control characters", () => {
    expect(toPerson(contact({ displayName: "Maria \u202Eevil" })).names).toBeUndefined();
    expect(toPerson(contact({ displayName: "Ma\u0000ria" })).names).toBeUndefined();
  });

  it("drops unsafe single-line fields but keeps line breaks in notes and address", () => {
    const person = toPerson(contact({}, { company: "Acme\u202D", notes: "linha 1\nlinha 2" }));
    expect(person.organizations).toEqual([{ title: "Diretora" }]);
    expect(person.biographies).toEqual([{ value: "linha 1\nlinha 2", contentType: "TEXT_PLAIN" }]);
    expect(toPerson(contact({}, { notes: "oi\u202E" })).biographies).toBeUndefined();
  });

  it("keeps only public http(s) urls without credentials", () => {
    const urls = [
      "https://acme.test",
      "https://user:pass@acme.test",
      "javascript:alert(1)",
      "ftp://acme.test",
      "not a url",
    ];
    expect(toPerson(contact({}, { urls })).urls).toEqual([{ value: "https://acme.test" }]);
  });
});
