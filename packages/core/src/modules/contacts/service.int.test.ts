// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, schema, withTenant } from "@crm/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AuthorizationError, NotFoundError } from "../../errors";
import type { TenantContext } from "../../tenant/context";
import { createContact, getContact, listOrgContacts } from "./service";

const { contacts, organizationMembers, organizations, users } = schema;

let db: Database;
let orgA: string;
let orgB: string;
let memberA: string;
let memberB: string;

function ctx(organizationId: string, userId: string, role: TenantContext["role"]): TenantContext {
  return { organizationId, userId, role, isPlatformAdmin: false };
}

beforeAll(async () => {
  const env = getServerEnv();
  db = createDb(env.database.url);
  try {
    await db.execute(sql`select 1`);
  } catch (error) {
    throw new Error(
      "Integration tests require a migrated database. Run `pnpm infra:up && pnpm db:migrate` first.",
      { cause: error },
    );
  }

  const suffix = crypto.randomUUID().slice(0, 8);
  const insertedUsers = await db
    .insert(users)
    .values([
      { name: "CT A", email: `it-ct-a-${suffix}@crm.local` },
      { name: "CT B", email: `it-ct-b-${suffix}@crm.local` },
    ])
    .returning({ id: users.id });
  [memberA, memberB] = insertedUsers.map((u) => u.id) as [string, string];

  const orgs = await db
    .insert(organizations)
    .values([
      { name: "Contacts IT A", slug: `ct-a-${suffix}` },
      { name: "Contacts IT B", slug: `ct-b-${suffix}` },
    ])
    .returning({ id: organizations.id });
  orgA = orgs[0]!.id;
  orgB = orgs[1]!.id;

  await db.insert(organizationMembers).values([
    { organizationId: orgA, userId: memberA, role: "agent" },
    { organizationId: orgB, userId: memberB, role: "agent" },
  ]);
}, 60_000);

afterAll(async () => {
  await db.delete(organizations).where(sql`${organizations.id} in (${orgA}, ${orgB})`);
  await db.delete(users).where(sql`${users.id} in (${memberA}, ${memberB})`);
  await db.$client.end();
});

describe("contacts service", () => {
  it("creates a contact with normalized WhatsApp chatId and email in metadata", async () => {
    const contact = await createContact(db, ctx(orgA, memberA, "agent"), {
      displayName: "Maria Silva",
      phone: "+55 11 99999-0001",
      email: "Maria@Example.com",
    });
    expect(contact.organizationId).toBe(orgA);
    expect(contact.channelUserId).toBe("5511999990001@c.us");
    expect(contact.displayName).toBe("Maria Silva");
    expect(contact.metadata).toMatchObject({ source: "manual", email: "maria@example.com" });
  });

  it("dedups on (org, channelUserId) — same phone returns the same row and refreshes the name", async () => {
    const first = await createContact(db, ctx(orgA, memberA, "agent"), {
      displayName: "João",
      phone: "+5511988887777",
    });
    const again = await createContact(db, ctx(orgA, memberA, "agent"), {
      displayName: "João Souza",
      phone: "+55 11 98888-7777",
    });
    expect(again.id).toBe(first.id);
    expect(again.displayName).toBe("João Souza");

    const list = await listOrgContacts(db, ctx(orgA, memberA, "agent"), {});
    expect(list.filter((c) => c.id === first.id)).toHaveLength(1);
  });

  it("rejects non-international phones with CONTACT_PHONE_INVALID", async () => {
    await expect(
      createContact(db, ctx(orgA, memberA, "agent"), {
        displayName: "Sem DDI",
        phone: "11999998888",
      }),
    ).rejects.toMatchObject({ code: "CONTACT_PHONE_INVALID" });
  });

  it("lists with search; org B never sees org A contacts (RLS)", async () => {
    await createContact(db, ctx(orgA, memberA, "agent"), {
      displayName: "Zoé Especial",
      phone: "+5511977776666",
    });

    const found = await listOrgContacts(db, ctx(orgA, memberA, "agent"), { query: "zoé" });
    expect(found.map((c) => c.displayName)).toContain("Zoé Especial");
    const byId = await listOrgContacts(db, ctx(orgA, memberA, "agent"), {
      query: "977776666",
    });
    expect(byId.map((c) => c.displayName)).toContain("Zoé Especial");

    const inB = await listOrgContacts(db, ctx(orgB, memberB, "agent"), { query: "zoé" });
    expect(inB).toHaveLength(0);

    // RLS at the row level: org B tx cannot even read org A's row by id.
    const visible = await withTenant(db, orgB, async (tx) =>
      tx
        .select()
        .from(contacts)
        .where(sql`${contacts.displayName} = 'Zoé Especial'`),
    );
    expect(visible).toHaveLength(0);
  });

  it("pages with limit/offset — contacts beyond the first page are reachable", async () => {
    // Regression: the page only ever asked for the first 50 rows.
    const prefix = `Pg${crypto.randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 3; i++) {
      await createContact(db, ctx(orgA, memberA, "agent"), {
        displayName: `${prefix} ${String(i).padStart(2, "0")}`,
        phone: `+5511900${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`,
      });
    }
    const page1 = await listOrgContacts(db, ctx(orgA, memberA, "agent"), {
      query: prefix,
      limit: 2,
      offset: 0,
    });
    const page2 = await listOrgContacts(db, ctx(orgA, memberA, "agent"), {
      query: prefix,
      limit: 2,
      offset: 2,
    });
    expect(page1.map((c) => c.displayName)).toEqual([`${prefix} 00`, `${prefix} 01`]);
    expect(page2.map((c) => c.displayName)).toEqual([`${prefix} 02`]);
  });

  it("viewer reads but cannot create", async () => {
    await expect(listOrgContacts(db, ctx(orgA, memberA, "viewer"), {})).resolves.toBeDefined();
    await expect(
      createContact(db, ctx(orgA, memberA, "viewer"), {
        displayName: "Nope",
        phone: "+5511999990002",
      }),
    ).rejects.toThrowError(AuthorizationError);
  });

  it("getContact enforces tenant scope", async () => {
    const contact = await createContact(db, ctx(orgA, memberA, "agent"), {
      displayName: "Só A",
      phone: "+5511966665555",
    });
    await expect(getContact(db, ctx(orgA, memberA, "viewer"), contact.id)).resolves.toMatchObject({
      id: contact.id,
    });
    await expect(getContact(db, ctx(orgB, memberB, "agent"), contact.id)).rejects.toThrowError(
      NotFoundError,
    );
  });
});
