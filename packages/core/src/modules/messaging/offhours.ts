// Off-hours auto-reply — one automatic reply per conversation per org-local
// day when an inbound lands outside the org's business hours. Pure helpers
// (isOutsideBusinessHours / nextOpeningAt / renderOffHoursMessage) are
// timezone-aware via Intl and unit-tested; maybeSendOffHoursReply is the
// job-side orchestration (marker row + provider send).
import type { ChannelProvider } from "@crm/channels";
import { providerForConnection } from "@crm/core/integrations";
import type { Database, DbExecutor } from "@crm/db";
import { emitDomainEvent, schema, sql, withTenant } from "@crm/db";

import type { BusinessHours } from "../organizations";
import { businessHoursSchema, findSettings } from "../organizations";
import { sendWithEnvelope } from "./outbound";
import type { ConversationRow, MessageRow } from "./repository";
import { getConversation, updateConversationLastMessage } from "./repository";

const { messages } = schema;

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
type DayKey = (typeof DAY_KEYS)[number];

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  dayKey: DayKey;
}

function zonedParts(date: Date, timeZone: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value])) as Record<
    string,
    string
  >;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    dayKey: parts.weekday!.slice(0, 3).toLowerCase() as DayKey,
  };
}

/** The org-local calendar day — the dedup key for "once per day". */
export function localDayKey(date: Date, timeZone: string): string {
  const p = zonedParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** "YYYY-MM-DD" for a UTC-millisecond day counter (date math helper). */
function tomorrowDate(utcMs: number): string {
  const d = new Date(utcMs);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function minutes({ hour, minute }: { hour: number; minute: number }): number {
  return hour * 60 + minute;
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
}

/**
 * True when `now` falls outside every window for the org-local weekday.
 * Provisional: a day with no configured windows (or an empty `windows`) is
 * closed — the feature is gated on `offHoursMessage` being set anyway.
 */
export function isOutsideBusinessHours(hours: BusinessHours, timeZone: string, now: Date): boolean {
  const parts = zonedParts(now, timeZone);
  const windows = hours.windows[parts.dayKey] ?? [];
  const nowMin = minutes(parts);
  return !windows.some((w) => hhmmToMinutes(w.start) <= nowMin && nowMin < hhmmToMinutes(w.end));
}

/** Offset of `timeZone` at `date` — wall-clock time minus UTC time. */
function tzOffsetMs(date: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(fmt.formatToParts(date).map((x) => [x.type, x.value]));
  const wall = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute),
    Number(p.second),
  );
  return wall - Math.floor(date.getTime() / 1000) * 1000;
}

/** Builds the UTC instant for a wall-clock time in `timeZone` (DST-safe: two passes). */
function wallToUtc(
  timeZone: string,
  parts: { year: number; month: number; day: number; hour: number; minute: number },
): Date {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const utc = guess - tzOffsetMs(new Date(guess), timeZone);
  return new Date(guess - tzOffsetMs(new Date(utc), timeZone));
}

/**
 * The next opening instant after `now`, searching up to 8 org-local days
 * ahead (covers a whole closed week). Returns null when the org has no
 * windows configured at all.
 */
export function nextOpeningAt(hours: BusinessHours, timeZone: string, now: Date): Date | null {
  const base = zonedParts(now, timeZone);
  for (let offset = 0; offset <= 8; offset++) {
    // Enumerate org-local calendar days (plain date math — no tz needed).
    const dayUtc = new Date(Date.UTC(base.year, base.month - 1, base.day + offset));
    const dayKey = DAY_KEYS[dayUtc.getUTCDay()]!;
    const windows = (hours.windows[dayKey] ?? [])
      .map((w) => ({ startMin: hhmmToMinutes(w.start), endMin: hhmmToMinutes(w.end) }))
      .sort((a, b) => a.startMin - b.startMin);
    for (const w of windows) {
      if (offset === 0 && w.startMin <= minutes(base)) continue; // already started today
      return wallToUtc(timeZone, {
        year: dayUtc.getUTCFullYear(),
        month: dayUtc.getUTCMonth() + 1,
        day: dayUtc.getUTCDate(),
        hour: Math.floor(w.startMin / 60),
        minute: w.startMin % 60,
      });
    }
  }
  return null;
}

/**
 * Interpolates `{proximo_atendimento}`: "hoje às HH:mm" / "amanhã às HH:mm" /
 * "dia DD/MM às HH:mm" — "em breve" when no window exists at all.
 */
export function renderOffHoursMessage(
  template: string,
  { next, now, timeZone }: { next: Date | null; now: Date; timeZone: string },
): string {
  let label = "em breve";
  if (next) {
    const nowParts = zonedParts(now, timeZone);
    const nextParts = zonedParts(next, timeZone);
    const here = localDayKey(now, timeZone);
    const there = localDayKey(next, timeZone);
    const tomorrowUtc = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1);
    const tomorrow = `${tomorrowDate(tomorrowUtc)}`;
    const hm = `${String(nextParts.hour).padStart(2, "0")}:${String(nextParts.minute).padStart(2, "0")}`;
    if (there === here) label = `hoje às ${hm}`;
    else if (there === tomorrow) label = `amanhã às ${hm}`;
    else {
      label = `dia ${String(nextParts.day).padStart(2, "0")}/${String(nextParts.month).padStart(2, "0")} às ${hm}`;
    }
  }
  return template.replaceAll("{proximo_atendimento}", label);
}

const SYSTEM_MARKER = "off_hours";

/**
 * Reserves today's marker row. The partial unique index
 * (conversation_id, metadata->>'autoReplyDay') makes concurrent jobs
 * conflict — one wins, the other gets undefined and skips. Returns the
 * marker row, or the existing failed row to retry, or undefined.
 */
async function reserveMarker(
  executor: DbExecutor,
  conv: ConversationRow,
  { dayKey, text }: { dayKey: string; text: string },
): Promise<MessageRow | undefined> {
  const [existing] = await executor
    .select()
    .from(messages)
    .where(
      sql`${messages.conversationId} = ${conv.id}
          and ${messages.metadata} ->> 'system' = ${SYSTEM_MARKER}
          and ${messages.metadata} ->> 'autoReplyDay' = ${dayKey}`,
    )
    .limit(1);
  if (existing) {
    // Failed attempt — the job is retrying: reuse the row.
    return existing.status === "failed" ? existing : undefined;
  }
  const [row] = await executor
    .insert(messages)
    .values({
      organizationId: conv.organizationId,
      conversationId: conv.id,
      channelConnectionId: conv.channelConnectionId,
      contactId: conv.contactId,
      direction: "outbound",
      content: { type: "text", text },
      externalId: null,
      status: "queued",
      sentAt: new Date(),
      authorId: null,
      metadata: { system: SYSTEM_MARKER, autoReplyDay: dayKey },
    })
    .onConflictDoNothing()
    .returning();
  return row;
}

export type OffHoursResult = { sent: true; messageId: string } | { sent: false; reason: string };

/**
 * Sends the off-hours auto-reply for a freshly received inbound, when the
 * org is configured for it and no reply went out today. System send: no
 * agent semantics — authorId null, ticket untouched (no assign, no
 * waiting_customer, no first_response_at). The marker row is reserved BEFORE
 * the provider call so concurrent jobs can't double-send; a provider
 * failure marks it `failed` (audit trail) and rethrows so pg-boss retries.
 */
type ReplyPlan =
  | {
      ok: true;
      organizationId: string;
      conv: ConversationRow;
      text: string;
      dayKey: string;
      now: Date;
    }
  | { ok: false; reason: string };

/** Loads conv + settings and applies every send gate before any write. */
async function planReply(
  db: Database,
  opts: { organizationId: string; conversationId: string; now?: Date },
): Promise<ReplyPlan> {
  const now = opts.now ?? new Date();
  const [conv, settings] = await withTenant(db, opts.organizationId, async (tx) =>
    Promise.all([getConversation(tx, opts.conversationId), findSettings(tx, opts.organizationId)]),
  );
  if (!conv || ["resolved", "closed"].includes(conv.status)) {
    return { ok: false, reason: "no-active-ticket" };
  }
  const template = settings?.offHoursMessage?.trim();
  if (!template) return { ok: false, reason: "not-configured" };
  const timeZone = settings?.timezone ?? "America/Sao_Paulo";
  // jsonb is untyped at read — malformed hours fall back to "always closed"
  // instead of poisoning the job's retry loop.
  const hours: BusinessHours = businessHoursSchema.safeParse(settings?.businessHours).data ?? {
    windows: {},
  };
  if (!isOutsideBusinessHours(hours, timeZone, now)) {
    return { ok: false, reason: "within-hours" };
  }
  const dayKey = localDayKey(now, timeZone);
  const text = renderOffHoursMessage(template, {
    next: nextOpeningAt(hours, timeZone, now),
    now,
    timeZone,
  });
  return { ok: true, organizationId: opts.organizationId, conv, text, dayKey, now };
}

/** Provider send (outside any tx) + marker update + fan-out event. */
async function deliverReply(
  db: Database,
  plan: Extract<ReplyPlan, { ok: true }>,
  { marker, deps }: { marker: MessageRow; deps?: { provider?: ChannelProvider } },
): Promise<OffHoursResult> {
  const provider =
    deps?.provider ??
    (await providerForConnection(db, plan.organizationId, plan.conv.channelConnectionId));
  let sent: { externalId: string; status: string };
  try {
    // Automated reply → full anti-ban envelope (seen → typing → paused → send).
    sent = await sendWithEnvelope(provider, plan.conv.externalId, plan.text);
  } catch (cause) {
    await withTenant(db, plan.organizationId, (tx) =>
      tx
        .update(messages)
        .set({ status: "failed", updatedAt: new Date() })
        .where(sql`${messages.id} = ${marker.id}`),
    );
    throw cause;
  }
  await withTenant(db, plan.organizationId, async (tx) => {
    await tx
      .update(messages)
      .set({
        externalId: sent.externalId,
        status: sent.status,
        // A retry may have sent a newer template than the first attempt —
        // the marker row mirrors what actually went out.
        content: { type: "text", text: plan.text },
        updatedAt: new Date(),
      })
      .where(sql`${messages.id} = ${marker.id}`);
    await updateConversationLastMessage(tx, plan.conv.id, {
      lastMessageAt: plan.now,
      lastMessage: {
        direction: "outbound",
        preview: plan.text,
      },
    });
    await emitDomainEvent(tx, {
      type: "message.sent",
      organizationId: plan.organizationId,
      conversationId: plan.conv.id,
      messageId: marker.id,
      authorId: null,
      sentAt: plan.now.toISOString(),
    });
  });
  return { sent: true, messageId: marker.id };
}

export async function maybeSendOffHoursReply(
  db: Database,
  opts: { organizationId: string; conversationId: string; now?: Date },
  deps?: { provider?: ChannelProvider },
): Promise<OffHoursResult> {
  const plan = await planReply(db, opts);
  if (!plan.ok) return { sent: false, reason: plan.reason };
  const marker = await withTenant(db, opts.organizationId, (tx) =>
    reserveMarker(tx, plan.conv, { dayKey: plan.dayKey, text: plan.text }),
  );
  if (!marker) return { sent: false, reason: "already-sent-today" };
  return deliverReply(db, plan, { marker, deps });
}
