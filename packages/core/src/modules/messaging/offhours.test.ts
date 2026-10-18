// Unit tests for the pure off-hours helpers — no DB, no infra.
import { describe, expect, it } from "vitest";

import type { BusinessHours } from "../organizations";
import {
  isOutsideBusinessHours,
  localDayKey,
  nextOpeningAt,
  renderOffHoursMessage,
} from "./offhours";

const TZ = "America/Sao_Paulo"; // UTC-3, no DST since 2019

const weekdays: BusinessHours = {
  windows: {
    mon: [{ start: "09:00", end: "18:00" }],
    tue: [{ start: "09:00", end: "18:00" }],
    wed: [{ start: "09:00", end: "18:00" }],
    thu: [{ start: "09:00", end: "18:00" }],
    fri: [{ start: "09:00", end: "18:00" }],
  },
};

// 2024-04-08 is a Monday. 12:00 UTC = 09:00 São Paulo.
const mon0900 = new Date("2024-04-08T12:00:00Z");
const mon1200 = new Date("2024-04-08T15:00:00Z"); // 12:00 SP
const mon2300 = new Date("2024-04-09T02:00:00Z"); // 23:00 SP
const sat1000 = new Date("2024-04-13T13:00:00Z"); // Sat 10:00 SP

describe("isOutsideBusinessHours", () => {
  it("is false inside a window and true outside it", () => {
    expect(isOutsideBusinessHours(weekdays, TZ, mon1200)).toBe(false);
    expect(isOutsideBusinessHours(weekdays, TZ, mon0900)).toBe(false); // boundary start
    expect(isOutsideBusinessHours(weekdays, TZ, mon2300)).toBe(true);
  });

  it("treats days absent from windows as closed", () => {
    expect(isOutsideBusinessHours(weekdays, TZ, sat1000)).toBe(true);
  });

  it("empty windows means always outside (gate is offHoursMessage)", () => {
    expect(isOutsideBusinessHours({ windows: {} }, TZ, mon1200)).toBe(true);
  });

  it("evaluates the instant in the org timezone, not UTC", () => {
    // 02:00 UTC Monday = 23:00 Sunday in São Paulo → closed even though
    // Monday business hours exist.
    expect(isOutsideBusinessHours(weekdays, TZ, new Date("2024-04-08T02:00:00Z"))).toBe(true);
    // Same instant is inside hours in Tokyo (UTC+9 → Monday 11:00).
    expect(isOutsideBusinessHours(weekdays, "Asia/Tokyo", new Date("2024-04-08T02:00:00Z"))).toBe(
      false,
    );
  });
});

describe("nextOpeningAt", () => {
  it("returns the same day's window when it hasn't started yet", () => {
    // 07:00 SP Monday → next opening is today 09:00 SP = 12:00 UTC.
    const next = nextOpeningAt(weekdays, TZ, new Date("2024-04-08T10:00:00Z"));
    expect(next?.toISOString()).toBe("2024-04-08T12:00:00.000Z");
  });

  it("skips to the next open day after today's windows end", () => {
    // Friday 23:00 SP → next is Monday 09:00 SP.
    const friLate = new Date("2024-04-13T02:00:00Z"); // Fri 23:00 SP
    const next = nextOpeningAt(weekdays, TZ, friLate);
    expect(next?.toISOString()).toBe("2024-04-15T12:00:00.000Z"); // Mon 09:00 SP
  });

  it("picks the earliest window of the next day", () => {
    const split: BusinessHours = {
      windows: {
        tue: [
          { start: "14:00", end: "18:00" },
          { start: "09:00", end: "12:00" },
        ],
      },
    };
    const next = nextOpeningAt(split, TZ, mon2300); // Mon night → Tue
    expect(next?.toISOString()).toBe("2024-04-09T12:00:00.000Z"); // Tue 09:00 SP
  });

  it("returns null when no windows are configured", () => {
    expect(nextOpeningAt({ windows: {} }, TZ, mon1200)).toBeNull();
  });
});

describe("localDayKey", () => {
  it("buckets by the org-local day across the UTC boundary", () => {
    // 01:00 UTC = 22:00 the previous day in SP.
    expect(localDayKey(new Date("2024-04-08T01:00:00Z"), TZ)).toBe("2024-04-07");
    expect(localDayKey(new Date("2024-04-08T01:00:00Z"), "UTC")).toBe("2024-04-08");
  });
});

describe("renderOffHoursMessage", () => {
  const tpl = "Estamos fora do horário. Retornamos {proximo_atendimento}.";

  it("interpolates hoje / amanhã / dia DD/MM / em breve", () => {
    const now = new Date("2024-04-13T02:00:00Z"); // Fri 23:00 SP
    // Same-day window that hasn't started.
    const today = nextOpeningAt(weekdays, TZ, new Date("2024-04-08T10:00:00Z"))!;
    expect(
      renderOffHoursMessage(tpl, {
        next: today,
        now: new Date("2024-04-08T10:00:00Z"),
        timeZone: TZ,
      }),
    ).toContain("hoje às 09:00");
    const tomorrow = nextOpeningAt(weekdays, TZ, mon2300)!;
    expect(renderOffHoursMessage(tpl, { next: tomorrow, now: mon2300, timeZone: TZ })).toContain(
      "amanhã às 09:00",
    );
    // Friday night → Monday is "dia 15/04".
    expect(
      renderOffHoursMessage(tpl, { next: nextOpeningAt(weekdays, TZ, now), now, timeZone: TZ }),
    ).toContain("dia 15/04 às 09:00");
    expect(renderOffHoursMessage(tpl, { next: null, now, timeZone: TZ })).toContain("em breve");
  });

  it("replaces every placeholder occurrence", () => {
    const both = renderOffHoursMessage("{proximo_atendimento} — repito: {proximo_atendimento}", {
      next: todayOf(weekdays),
      now: new Date("2024-04-08T10:00:00Z"),
      timeZone: TZ,
    });
    expect(both).toBe("hoje às 09:00 — repito: hoje às 09:00");
  });
});

function todayOf(hours: BusinessHours): Date | null {
  return nextOpeningAt(hours, TZ, new Date("2024-04-08T10:00:00Z"));
}
