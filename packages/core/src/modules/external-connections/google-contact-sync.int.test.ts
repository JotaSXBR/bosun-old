// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { TenantContext } from "../../tenant/context";
import { findContactById } from "../contacts";
import { syncContactToGoogle } from "./google-contact-sync";
import type { GoogleOAuthClient } from "./google-oauth";
import { GoogleOAuthError } from "./google-oauth";
import type { GooglePeopleClient, GooglePerson } from "./google-people";
import { GooglePeopleError } from "./google-people";
import { completeGoogleAuthorization, getGoogleStatus, saveGoogleClient } from "./service";

const { contacts, externalConnections, organizations } = schema;

const ORIGINAL_KEY = process.env.CHANNEL_CREDENTIALS_KEY;
const REDIRECT = "https://app.test/api/integrations/google/callback";

let db: Database;
let orgId: string;
let ctx: TenantContext;

const oauth: GoogleOAuthClient = {
  buildAuthUrl: ({ state }) => `https://accounts.google.test/auth?state=${state}`,
  exchangeCode: () =>
    Promise.resolve({
      tokens: {
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      accountEmail: "owner@acme.test",
    }),
  refreshAccessToken: () => Promise.reject(new Error("not expected")),
  revokeToken: () => Promise.resolve(),
};

type Calls = string[];

function fakePeople(
  overrides: Partial<GooglePeopleClient> = {},
  calls: Calls = [],
): GooglePeopleClient {
  const person = (resourceName: string, etag = "etag-1"): GooglePerson => ({
    resourceName,
    source: { type: "CONTACT", id: resourceName.slice(7), etag },
    phones: [],
    emails: [],
  });
  return {
    searchContacts: () => {
      calls.push("search");
      return Promise.resolve([]);
    },
    getContact: ({ resourceName }) => {
      calls.push("get");
      return Promise.resolve(person(resourceName));
    },
    createContact: () => {
      calls.push("create");
      return Promise.resolve(person("people/c1"));
    },
    updateContact: ({ current }) => {
      calls.push("update");
      return Promise.resolve(person(current.resourceName, "etag-2"));
    },
    ...overrides,
  };
}

async function newContact(values: { channelUserId: string; displayName: string }) {
  const [row] = await withTenant(db, orgId, (tx) =>
    tx
      .insert(contacts)
      .values({ organizationId: orgId, ...values })
      .returning({ id: contacts.id }),
  );
  return row!.id;
}

const stored = async (contactId: string) => {
  const row = await withTenant(db, orgId, (tx) => findContactById(tx, contactId));
  return row!;
};

async function connect() {
  const { authUrl } = await saveGoogleClient(
    db,
    ctx,
    { clientId: "client-id-123", clientSecret: "client-secret-456", redirectUri: REDIRECT },
    oauth,
  );
  await completeGoogleAuthorization(
    db,
    ctx,
    { code: "code", state: new URL(authUrl).searchParams.get("state")!, redirectUri: REDIRECT },
    oauth,
  );
}

beforeAll(async () => {
  process.env.CHANNEL_CREDENTIALS_KEY = "b".repeat(64);
  db = createDb(getServerEnv().database.url);
  try {
    await db.execute(sql`select 1`);
  } catch (error) {
    throw new Error(
      "Integration tests require a migrated database. Run `pnpm infra:up && pnpm db:migrate` first.",
      { cause: error },
    );
  }
  const [org] = await db
    .insert(organizations)
    .values({ name: "GSync IT", slug: `gsync-it-${crypto.randomUUID().slice(0, 8)}` })
    .returning({ id: organizations.id });
  orgId = org!.id;
  ctx = { organizationId: orgId, userId: "user-1", role: "admin", isPlatformAdmin: false };
}, 60_000);

afterAll(async () => {
  process.env.CHANNEL_CREDENTIALS_KEY = ORIGINAL_KEY;
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.$client.end();
});

beforeEach(async () => {
  await db.delete(externalConnections).where(eq(externalConnections.organizationId, orgId));
});

describe("syncContactToGoogle", () => {
  it("does nothing without a connected account", async () => {
    const calls: Calls = [];
    const id = await newContact({ channelUserId: "5511999990001@c.us", displayName: "Ana" });
    const outcome = await syncContactToGoogle(
      db,
      { organizationId: orgId, contactId: id },
      { oauth, people: fakePeople({}, calls) },
    );
    expect(outcome).toBe("skipped");
    expect(calls).toEqual([]);
    expect((await stored(id)).metadata.google).toBeUndefined();
  });

  it("creates, then skips the unchanged payload, then updates after an edit — without touching updated_at", async () => {
    await connect();
    const calls: Calls = [];
    const people = fakePeople({}, calls);
    const id = await newContact({ channelUserId: "5511999990002@c.us", displayName: "Bia" });
    const before = (await stored(id)).updatedAt;
    const run = () =>
      syncContactToGoogle(db, { organizationId: orgId, contactId: id }, { oauth, people });

    expect(await run()).toBe("created");
    expect(calls).toEqual(["search", "create"]);
    const google = (await stored(id)).metadata.google as Record<string, unknown>;
    expect(google).toMatchObject({ resourceName: "people/c1", etag: "etag-1" });
    expect((await stored(id)).updatedAt).toEqual(before);

    calls.length = 0;
    expect(await run()).toBe("unchanged");
    expect(calls).toEqual([]);

    await withTenant(db, orgId, (tx) =>
      tx.update(contacts).set({ displayName: "Bia Souza" }).where(eq(contacts.id, id)),
    );
    calls.length = 0;
    expect(await run()).toBe("updated");
    expect(calls).toEqual(["get", "update"]);
    expect((await stored(id)).metadata.google).toMatchObject({ etag: "etag-2" });
  });

  it("adopts an existing Google contact with the exact same phone instead of duplicating", async () => {
    await connect();
    const calls: Calls = [];
    const people = fakePeople(
      {
        searchContacts: () =>
          Promise.resolve([
            { resourceName: "people/near", source: null, phones: ["+5511999990030"], emails: [] },
            {
              resourceName: "people/exact",
              source: { type: "CONTACT", id: "exact", etag: "e" },
              phones: ["+5511999990003"],
              emails: [],
            },
          ]),
      },
      calls,
    );
    const id = await newContact({ channelUserId: "5511999990003@c.us", displayName: "Caio" });
    const outcome = await syncContactToGoogle(
      db,
      { organizationId: orgId, contactId: id },
      { oauth, people },
    );
    expect(outcome).toBe("updated");
    expect(calls).toEqual(["update"]);
    expect((await stored(id)).metadata.google).toMatchObject({ resourceName: "people/exact" });
  });

  it("rereads once on an etag conflict and retries", async () => {
    await connect();
    const calls: Calls = [];
    let first = true;
    const people = fakePeople(
      {
        updateContact: ({ current }) => {
          calls.push("update");
          if (first) {
            first = false;
            return Promise.reject(new GooglePeopleError("conflict", 400));
          }
          return Promise.resolve({ ...current, source: { ...current.source!, etag: "etag-3" } });
        },
      },
      calls,
    );
    const id = await newContact({ channelUserId: "5511999990004@c.us", displayName: "Dani" });
    await syncContactToGoogle(
      db,
      { organizationId: orgId, contactId: id },
      { oauth, people: fakePeople() },
    );
    await withTenant(db, orgId, (tx) =>
      tx.update(contacts).set({ displayName: "Dani B" }).where(eq(contacts.id, id)),
    );
    calls.length = 0;
    const outcome = await syncContactToGoogle(
      db,
      { organizationId: orgId, contactId: id },
      { oauth, people },
    );
    expect(outcome).toBe("updated");
    expect(calls).toEqual(["get", "update", "get", "update"]);
    expect((await stored(id)).metadata.google).toMatchObject({ etag: "etag-3" });
  });

  it("records a Google failure as lastError and keeps the earlier mirror state", async () => {
    await connect();
    const id = await newContact({ channelUserId: "5511999990005@c.us", displayName: "Edu" });
    await syncContactToGoogle(
      db,
      { organizationId: orgId, contactId: id },
      { oauth, people: fakePeople() },
    );
    await withTenant(db, orgId, (tx) =>
      tx.update(contacts).set({ displayName: "Edu B" }).where(eq(contacts.id, id)),
    );
    const people = fakePeople({
      updateContact: () => Promise.reject(new GooglePeopleError("rate_limited", 429)),
    });
    const outcome = await syncContactToGoogle(
      db,
      { organizationId: orgId, contactId: id },
      { oauth, people },
    );
    expect(outcome).toBe("failed");
    expect((await stored(id)).metadata.google).toMatchObject({
      resourceName: "people/c1",
      lastError: "rate_limited",
    });
  });

  it("marks the connection needs_reauth when the token is revoked, and sends nothing", async () => {
    // Force an expired access token so the sync must refresh.
    const expired: GoogleOAuthClient = {
      ...oauth,
      exchangeCode: () =>
        Promise.resolve({
          tokens: { accessToken: "a", refreshToken: "r", expiresAt: new Date(0).toISOString() },
          accountEmail: null,
        }),
    };
    const { authUrl } = await saveGoogleClient(
      db,
      ctx,
      { clientId: "client-id-123", clientSecret: "client-secret-456", redirectUri: REDIRECT },
      expired,
    );
    await completeGoogleAuthorization(
      db,
      ctx,
      { code: "c", state: new URL(authUrl).searchParams.get("state")!, redirectUri: REDIRECT },
      expired,
    );
    const calls: Calls = [];
    const revoked: GoogleOAuthClient = {
      ...oauth,
      refreshAccessToken: () => Promise.reject(new GoogleOAuthError("invalid_grant")),
    };
    const id = await newContact({ channelUserId: "5511999990006@c.us", displayName: "Fer" });
    const outcome = await syncContactToGoogle(
      db,
      { organizationId: orgId, contactId: id },
      { oauth: revoked, people: fakePeople({}, calls) },
    );
    expect(outcome).toBe("skipped");
    expect(calls).toEqual([]);
    expect((await getGoogleStatus(db, ctx))?.status).toBe("needs_reauth");
  });

  it("recreates a contact deleted in Google, and does not adopt a prefix-only match", async () => {
    await connect();
    const calls: Calls = [];
    const people = fakePeople(
      {
        getContact: () => {
          calls.push("get");
          return Promise.resolve(null);
        },
        searchContacts: () => {
          calls.push("search");
          return Promise.resolve([
            { resourceName: "people/near", source: null, phones: ["+55119999900070"], emails: [] },
          ]);
        },
      },
      calls,
    );
    const id = await newContact({ channelUserId: "5511999990007@c.us", displayName: "Gus" });
    await syncContactToGoogle(
      db,
      { organizationId: orgId, contactId: id },
      { oauth, people: fakePeople() },
    );
    await withTenant(db, orgId, (tx) =>
      tx.update(contacts).set({ displayName: "Gus B" }).where(eq(contacts.id, id)),
    );
    calls.length = 0;
    const outcome = await syncContactToGoogle(
      db,
      { organizationId: orgId, contactId: id },
      { oauth, people },
    );
    expect(outcome).toBe("created");
    expect(calls).toEqual(["get", "search", "create"]);
  });

  it("adopts by e-mail, and clears lastError after a later success", async () => {
    await connect();
    const id = await newContact({ channelUserId: "site:visitor-1", displayName: "Hana" });
    await withTenant(db, orgId, (tx) =>
      tx
        .update(contacts)
        .set({ metadata: sql`${contacts.metadata} || '{"email":"Hana@Acme.test"}'::jsonb` })
        .where(eq(contacts.id, id)),
    );
    const failing = fakePeople({
      searchContacts: () => Promise.reject(new GooglePeopleError("unavailable", 503)),
    });
    expect(
      await syncContactToGoogle(
        db,
        { organizationId: orgId, contactId: id },
        { oauth, people: failing },
      ),
    ).toBe("failed");
    expect((await stored(id)).metadata.google).toMatchObject({ lastError: "unavailable" });

    const people = fakePeople({
      searchContacts: () =>
        Promise.resolve([
          {
            resourceName: "people/hana",
            source: { type: "CONTACT", id: "hana", etag: "e" },
            phones: [],
            emails: ["hana@acme.test"],
          },
        ]),
    });
    expect(
      await syncContactToGoogle(db, { organizationId: orgId, contactId: id }, { oauth, people }),
    ).toBe("updated");
    const google = (await stored(id)).metadata.google as Record<string, unknown>;
    expect(google.resourceName).toBe("people/hana");
    expect(google).not.toHaveProperty("lastError");
  });

  it("skips an ineligible contact (no phone number, no e-mail)", async () => {
    await connect();
    const calls: Calls = [];
    const id = await newContact({ channelUserId: "site:visitor-2", displayName: "Ivo" });
    const outcome = await syncContactToGoogle(
      db,
      { organizationId: orgId, contactId: id },
      { oauth, people: fakePeople({}, calls) },
    );
    expect(outcome).toBe("skipped");
    expect(calls).toEqual([]);
  });

  it("surfaces two conflicts in a row as lastError", async () => {
    await connect();
    const id = await newContact({ channelUserId: "5511999990008@c.us", displayName: "Jô" });
    await syncContactToGoogle(
      db,
      { organizationId: orgId, contactId: id },
      { oauth, people: fakePeople() },
    );
    await withTenant(db, orgId, (tx) =>
      tx.update(contacts).set({ displayName: "Jô B" }).where(eq(contacts.id, id)),
    );
    const people = fakePeople({
      updateContact: () => Promise.reject(new GooglePeopleError("conflict", 400)),
    });
    expect(
      await syncContactToGoogle(db, { organizationId: orgId, contactId: id }, { oauth, people }),
    ).toBe("failed");
    expect((await stored(id)).metadata.google).toMatchObject({ lastError: "conflict" });
  });

  it("never reads another organization's contact", async () => {
    await connect();
    const calls: Calls = [];
    const [other] = await db
      .insert(organizations)
      .values({ name: "GSync IT B", slug: `gsync-it-b-${crypto.randomUUID().slice(0, 8)}` })
      .returning({ id: organizations.id });
    try {
      const id = await newContact({ channelUserId: "5511999990009@c.us", displayName: "Kai" });
      const outcome = await syncContactToGoogle(
        db,
        { organizationId: other!.id, contactId: id },
        { oauth, people: fakePeople({}, calls) },
      );
      expect(outcome).toBe("skipped");
      expect(calls).toEqual([]);
      expect((await stored(id)).metadata.google).toBeUndefined();
    } finally {
      await db.delete(organizations).where(eq(organizations.id, other!.id));
    }
  });

  it("clears in Google a field emptied in Bosun, but only sends present fields when adopting", async () => {
    await connect();
    const sent: string[][] = [];
    const people = fakePeople({
      updateContact: ({ current, fields }) => {
        sent.push(fields);
        return Promise.resolve({ ...current, source: { ...current.source!, etag: "etag-9" } });
      },
    });
    const id = await newContact({ channelUserId: "5511999990021@c.us", displayName: "Lia" });
    await withTenant(db, orgId, (tx) =>
      tx
        .update(contacts)
        .set({ metadata: sql`${contacts.metadata} || '{"company":"Acme"}'::jsonb` })
        .where(eq(contacts.id, id)),
    );
    await syncContactToGoogle(db, { organizationId: orgId, contactId: id }, { oauth, people });
    await withTenant(db, orgId, (tx) =>
      tx
        .update(contacts)
        .set({ metadata: sql`${contacts.metadata} - 'company'` })
        .where(eq(contacts.id, id)),
    );

    const outcome = await syncContactToGoogle(
      db,
      { organizationId: orgId, contactId: id },
      { oauth, people },
    );
    expect(outcome).toBe("updated");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("organizations"); // absent in the payload, still in the mask => cleared

    const adopting = fakePeople({
      searchContacts: () =>
        Promise.resolve([
          {
            resourceName: "people/theirs",
            source: { type: "CONTACT", id: "theirs", etag: "e" },
            phones: ["+5511999990022"],
            emails: [],
          },
        ]),
      updateContact: ({ current, fields }) => {
        sent.push(fields);
        return Promise.resolve(current);
      },
    });
    const other = await newContact({ channelUserId: "5511999990022@c.us", displayName: "Teo" });
    await syncContactToGoogle(
      db,
      { organizationId: orgId, contactId: other },
      { oauth, people: adopting },
    );
    expect(sent[1]).not.toContain("organizations"); // first adoption never wipes their data
  });
  it.each(["unauthorized", "forbidden"] as const)(
    "flags the connection needs_reauth when the People API answers %s",
    async (code) => {
      await connect();
      const id = await newContact({
        channelUserId: `55119999900${code === "forbidden" ? 41 : 31}@c.us`,
        displayName: "Uma",
      });
      const people = fakePeople({
        searchContacts: () => Promise.reject(new GooglePeopleError(code, 401)),
      });
      const outcome = await syncContactToGoogle(
        db,
        { organizationId: orgId, contactId: id },
        { oauth, people },
      );
      expect(outcome).toBe("failed");
      expect((await stored(id)).metadata.google).toMatchObject({ lastError: code });
      expect(await getGoogleStatus(db, ctx)).toMatchObject({ status: "needs_reauth" });
    },
  );

  it("rethrows an unexpected error without recording lastError", async () => {
    await connect();
    const id = await newContact({ channelUserId: "5511999990032@c.us", displayName: "Vik" });
    const people = fakePeople({ createContact: () => Promise.reject(new TypeError("boom")) });
    await expect(
      syncContactToGoogle(db, { organizationId: orgId, contactId: id }, { oauth, people }),
    ).rejects.toThrow("boom");
    expect((await stored(id)).metadata.google).toBeUndefined();
  });

  it("treats corrupted mirror metadata as never synced", async () => {
    await connect();
    const id = await newContact({ channelUserId: "5511999990033@c.us", displayName: "Wal" });
    await withTenant(db, orgId, (tx) =>
      tx
        .update(contacts)
        .set({ metadata: sql`jsonb_build_object('google', 'garbage')` })
        .where(eq(contacts.id, id)),
    );
    const outcome = await syncContactToGoogle(
      db,
      { organizationId: orgId, contactId: id },
      { oauth, people: fakePeople() },
    );
    expect(outcome).toBe("created");
  });
});
