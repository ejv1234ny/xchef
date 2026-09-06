import { describe, expect, it } from "vitest";
import { parseJobTitles, parseTimeEntries, planLaborWindows } from "./labor";

/** Two entries in the shape of the real GET /labor/v1/timeEntries payload (guids only, no names). */
const ENTRIES = [
  {
    guid: "fbf10a5f-b324-4614-bb07-d8de15e4b72b",
    entityType: "TimeEntry",
    employeeReference: { guid: "83b66f2f-1ed9-43d4-8ecd-adcd291069d1", entityType: "RestaurantUser" },
    jobReference: { guid: "ad4879bf-14fe-455a-97df-9aa0417cb35e", entityType: "RestaurantJob" },
    regularHours: 4.1,
    overtimeHours: 0.0,
    businessDate: "20260903",
    inDate: "2026-09-03T15:05:48.505+0000",
    outDate: "2026-09-03T19:11:38.471+0000",
    hourlyWage: 20.0,
    declaredCashTips: null,
    cashGratuityServiceCharges: 0.0,
    nonCashTips: 0.0,
    nonCashGratuityServiceCharges: 0.0,
    breaks: [],
    deleted: false,
    modifiedDate: "2026-09-03T19:11:38.933+0000",
  },
  {
    guid: "967533ad-e330-4bd0-8ad0-97482fa6339f",
    employeeReference: { guid: "ef75723b-edba-4b5b-b3fb-af6e7cb8478a" },
    jobReference: { guid: "8b14a34a-6373-46dd-a107-1b57c64d0522" },
    regularHours: 8.28,
    overtimeHours: 0.5,
    businessDate: 20260903,
    inDate: "2026-09-03T17:34:59.906+0000",
    outDate: "2026-09-04T01:52:04.958+0000",
    hourlyWage: 7.5,
    declaredCashTips: 40,
    cashGratuityServiceCharges: 0,
    nonCashTips: 112.35,
    nonCashGratuityServiceCharges: 10,
    deleted: false,
  },
  { guid: "bad", businessDate: "not a date" },
  { nope: true },
];

const JOBS = [
  { guid: "ad4879bf-14fe-455a-97df-9aa0417cb35e", title: "Line Cook", deleted: false, wageFrequency: "HOURLY" },
  { guid: "8b14a34a-6373-46dd-a107-1b57c64d0522", title: "Server", deleted: false },
  { guid: "x", title: null },
];

describe("parseTimeEntries", () => {
  it("keeps hours, wage and tips as fixed strings, business date as ISO, only the employee guid and job title", () => {
    const { rows, quarantined } = parseTimeEntries(ENTRIES, parseJobTitles(JOBS));
    expect(rows).toHaveLength(2);
    expect(quarantined).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      toast_guid: "fbf10a5f-b324-4614-bb07-d8de15e4b72b",
      employee_guid: "83b66f2f-1ed9-43d4-8ecd-adcd291069d1",
      job_title: "Line Cook",
      business_date: "2026-09-03",
      clock_in: "2026-09-03T15:05:48.505Z",
      clock_out: "2026-09-03T19:11:38.471Z",
      regular_hours: "4.1000",
      overtime_hours: "0.0000",
      wage: "20.0000",
      tips_declared: null,
      cash_tips: "0.00",
      non_cash_tips: "0.00",
      deleted: false,
    });
    expect(rows[1]).toMatchObject({ business_date: "2026-09-03", job_title: "Server", regular_hours: "8.2800", overtime_hours: "0.5000", wage: "7.5000", tips_declared: "40.00", non_cash_tips: "122.35" });
    expect(Object.keys(rows[0])).not.toContain("name");
  });
  it("quarantines a non-array payload", () => {
    expect(parseTimeEntries({ x: 1 }).quarantined[0].reason).toContain("not an array");
  });
});

describe("planLaborWindows", () => {
  it("splits 90 days into three 30-day windows Toast accepts", () => {
    const end = new Date("2026-09-06T12:00:00Z");
    const start = new Date(end.getTime() - 90 * 86_400_000);
    const w = planLaborWindows(start, end);
    expect(w).toHaveLength(3);
    expect(w[0].start).toEqual(start);
    expect(w[2].end).toEqual(end);
    expect((w[0].end.getTime() - w[0].start.getTime()) / 86_400_000).toBe(30);
  });
  it("a 36-hour re-pull is one window", () => {
    const end = new Date("2026-09-06T12:00:00Z");
    expect(planLaborWindows(new Date(end.getTime() - 36 * 3_600_000), end)).toHaveLength(1);
  });
});
