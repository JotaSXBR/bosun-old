// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import type { Database } from "@crm/db";
import { schema, withTenant } from "@crm/db";
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { TenantContext } from "../../tenant/context";
import { syncContactToGoogle } from "./google-contact-sync";
import type { GoogleOAuthClient } from "./google-oauth";
import { GoogleOAuthError } from "./google-oauth";
import { GooglePeopleError } from "./google-people";
import type { Calls } from "./google-sync.fixture";
import { fakePeople, oauth, REDIRECT, useGoogleSyncFixture } from "./google-sync.fixture";
import { listPendingGoogleSyncContactIds } from "./google-sync-contacts";
import {
  completeGoogleAuthorization,
  enableGoogleAutoSync,
  getGoogleStatus,
  saveGoogleClient,
} from "./service";

const { contacts } = schema;

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

  it("sends nothing without auto-sync consent, even with a connected account", async () => {
    await connect(false);
    const calls: Calls = [];
    const id = await newContact({ channelUserId: "5511999990011@c.us", displayName: "Caio" });
    const outcome = await syncContactToGoogle(
      db,
      { organizationId: orgId, contactId: id },
      { oauth, people: fakePeople({}, calls) },
    );
    expect(outcome).toBe("skipped");
    expect(calls).toEqual([]);
  });

  it("leaves the pending list after a sync and returns to it after an edit", async () => {
    await connect();
    const id = await newContact({ channelUserId: "5511999990012@c.us", displayName: "Dani" });
    const pending = async () =>
      (await listPendingGoogleSyncContactIds(db, orgId, { limit: 100 })).ids;
    expect(await pending()).toContain(id);

    await syncContactToGoogle(
      db,
      { organizationId: orgId, contactId: id },
      { oauth, people: fakePeople() },
    );
    expect(await pending()).not.toContain(id);

    await withTenant(db, orgId, (tx) =>
      tx
        .update(contacts)
        .set({ displayName: "Dani Lima", updatedAt: new Date() })
        .where(eq(contacts.id, id)),
    );
    expect(await pending()).toContain(id);
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
    // The no-op still stamps the attempt, so the sweep stops treating the contact as pending.
    const checked = (await stored(id)).metadata.google as Record<string, string>;
    expect(checked.lastAttemptAt! >= checked.lastSyncedAt!).toBe(true);
    expect(checked.payloadHash).toBeDefined();

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
    expect((await stored(id)).metadata.google).toHaveProperty("lastAttemptAt");
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
    const { authUrl } = await saveGoogleClient(db, ctx, {
      input: {
        clientId: "client-id-123",
        clientSecret: "client-secret-456",
        redirectUri: REDIRECT,
      },
      oauth: expired,
    });
    await completeGoogleAuthorization(db, ctx, {
      input: {
        code: "c",
        state: new URL(authUrl).searchParams.get("state")!,
        redirectUri: REDIRECT,
      },
      oauth: expired,
    });
    await enableGoogleAutoSync(db, ctx);
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
});
