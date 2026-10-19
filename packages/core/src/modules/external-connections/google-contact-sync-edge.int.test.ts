// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import type { Database } from "@crm/db";
import { schema, withTenant } from "@crm/db";
import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { TenantContext } from "../../tenant/context";
import { syncContactToGoogle } from "./google-contact-sync";
import { GooglePeopleError } from "./google-people";
import type { Calls } from "./google-sync.fixture";
import { fakePeople, oauth, useGoogleSyncFixture } from "./google-sync.fixture";
import { getGoogleStatus } from "./service";

const { contacts, organizations } = schema;

const fx = useGoogleSyncFixture();
const { newContact, stored, connect } = fx;

let db: Database;
let orgId: string;
let ctx: TenantContext;

// Runs after the fixture's own hooks, which create them.
beforeAll(() => {
  db = fx.db();
  orgId = fx.orgId();
  ctx = fx.ctx();
});

describe("syncContactToGoogle (cont.)", () => {
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
