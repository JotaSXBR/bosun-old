// Integration test — requires Postgres with migrations applied.
// Run: pnpm infra:up && pnpm db:migrate && pnpm test:integration
import { getServerEnv } from "@crm/config";
import type { Database } from "@crm/db";
import { createDb, sql } from "@crm/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getBoss, QUEUES, startJobs } from "./boss";
import { enqueueChannelEventProcessed, enqueueContactGoogleSync } from "./enqueue";

let db: Database;

const payload = {
  organizationId: "018f8b9a-7c3d-7f2e-9a4b-1c2d3e4f5a6b",
  channelConnectionId: "218f8b9a-7c3d-7f2e-9a4b-1c2d3e4f5a6b",
  eventType: "message.received" as const,
  messageId: "318f8b9a-7c3d-7f2e-9a4b-1c2d3e4f5a6b",
};

async function jobRows() {
  return db.execute<{ id: string; state: string }>(
    sql`select id, state from pgboss.job where name = ${QUEUES.processChannelEvent} and data->>'messageId' = ${payload.messageId}`,
  );
}

beforeAll(async () => {
  db = createDb(getServerEnv().database.url);
  await startJobs();
}, 60_000);

afterAll(async () => {
  await db.execute(
    sql`delete from pgboss.job where name = ${QUEUES.processChannelEvent} and data->>'messageId' = ${payload.messageId}`,
  );
  await getBoss()?.stop();
  await db.$client.end();
});

describe("enqueueChannelEventProcessed (pg-boss)", () => {
  it("commits the job row atomically with the caller's transaction", async () => {
    await expect(
      db.transaction(async (tx) => {
        const result = await enqueueChannelEventProcessed(
          { ...payload, messageId: payload.messageId },
          tx,
        );
        expect(result).toEqual({ skipped: false });
        // Visible inside the same transaction…
        const rows = await tx.execute<{ id: string }>(
          sql`select id from pgboss.job where name = ${QUEUES.processChannelEvent} and data->>'messageId' = ${payload.messageId}`,
        );
        expect(rows.length).toBe(1);
        // …and gone if the transaction rolls back.
        throw new Error("force rollback");
      }),
    ).rejects.toThrow("force rollback");
    expect((await jobRows()).length).toBe(0);
  });

  it("sends post-commit when no transaction is passed", async () => {
    const result = await enqueueChannelEventProcessed({
      ...payload,
      messageId: undefined,
    });
    expect(result).toEqual({ skipped: false });
    const rows = await db.execute<{ id: string; state: string }>(
      sql`select id, state from pgboss.job where name = ${QUEUES.processChannelEvent} and data->>'messageId' is null order by created_on desc limit 1`,
    );
    expect(rows.length).toBe(1);
    await db.execute(
      sql`delete from pgboss.job where name = ${QUEUES.processChannelEvent} and id = ${rows[0]!.id}`,
    );
  });
});

describe("contact-google-sync queue (pg-boss)", () => {
  const sync = {
    organizationId: "418f8b9a-7c3d-7f2e-9a4b-1c2d3e4f5a6b",
    contactId: "518f8b9a-7c3d-7f2e-9a4b-1c2d3e4f5a6b",
  };

  it("is a key_strict_fifo queue, so Google mutations run one at a time per organization", async () => {
    const rows = await db.execute<{ policy: string }>(
      sql`select policy from pgboss.queue where name = ${QUEUES.contactGoogleSync}`,
    );
    expect(rows[0]?.policy).toBe("key_strict_fifo");
  });

  it("enqueues every job under the organization's singleton key", async () => {
    expect(await enqueueContactGoogleSync(sync)).toEqual({ skipped: false });
    const rows = await db.execute<{ singleton_key: string | null }>(
      sql`select singleton_key from pgboss.job where name = ${QUEUES.contactGoogleSync} and data->>'contactId' = ${sync.contactId}`,
    );
    expect(rows.map((row) => row.singleton_key)).toEqual([`google:${sync.organizationId}`]);
    await db.execute(
      sql`delete from pgboss.job where name = ${QUEUES.contactGoogleSync} and data->>'contactId' = ${sync.contactId}`,
    );
  });
});
