import { z } from "zod";
import Decimal from "decimal.js";
import { businessDateToIso } from "./dates";

/**
 * Toast Labor API (GET /labor/v1/timeEntries?startDate&endDate, scope
 * labor:read) → labor_entries rows. Pure: the sync job (lib/jobs/laborSync.ts)
 * validates each entry here and upserts what comes back. Nothing personal is
 * kept beyond the employee guid and the job title (no names, no employee
 * details endpoint). Money and hours stay strings until the database.
 */
export const TimeEntrySchema = z.looseObject({
  guid: z.string(),
  employeeReference: z.looseObject({ guid: z.string() }).nullish(),
  jobReference: z.looseObject({ guid: z.string() }).nullish(),
  businessDate: z.union([z.number().int(), z.string()]),
  inDate: z.string().nullish(),
  outDate: z.string().nullish(),
  regularHours: z.number().nullish(),
  overtimeHours: z.number().nullish(),
  hourlyWage: z.number().nullish(),
  declaredCashTips: z.number().nullish(),
  cashGratuityServiceCharges: z.number().nullish(),
  nonCashTips: z.number().nullish(),
  nonCashGratuityServiceCharges: z.number().nullish(),
  deleted: z.boolean().nullish(),
  modifiedDate: z.string().nullish(),
});
export type ToastTimeEntry = z.infer<typeof TimeEntrySchema>;

export const JobSchema = z.looseObject({ guid: z.string(), title: z.string().nullish(), deleted: z.boolean().nullish() });

export type LaborEntryRow = {
  toast_guid: string;
  employee_guid: string | null;
  job_guid: string | null;
  job_title: string | null;
  business_date: string;
  clock_in: string | null;
  clock_out: string | null;
  regular_hours: string;
  overtime_hours: string;
  wage: string | null;
  tips_declared: string | null;
  cash_tips: string | null;
  non_cash_tips: string | null;
  deleted: boolean;
  toast_modified_at: string | null;
};

const h4 = (n: number | null | undefined): string => new Decimal(n ?? 0).toFixed(4);
const m2 = (n: number | null | undefined): string | null => (n == null ? null : new Decimal(n).toFixed(2));
const iso = (s: string | null | undefined): string | null => {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** Validate a page of time entries; invalid ones are quarantined (never thrown). */
export function parseTimeEntries(raw: unknown, jobTitles: Map<string, string> = new Map()): { rows: LaborEntryRow[]; quarantined: Array<{ guid: string | null; reason: string }> } {
  const rows: LaborEntryRow[] = [];
  const quarantined: Array<{ guid: string | null; reason: string }> = [];
  if (!Array.isArray(raw)) return { rows, quarantined: [{ guid: null, reason: "payload is not an array" }] };
  for (const entry of raw) {
    const p = TimeEntrySchema.safeParse(entry);
    if (!p.success) {
      const guid = typeof entry === "object" && entry && "guid" in entry && typeof (entry as { guid: unknown }).guid === "string" ? (entry as { guid: string }).guid : null;
      quarantined.push({ guid, reason: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      continue;
    }
    let business_date: string;
    try {
      business_date = businessDateToIso(p.data.businessDate);
    } catch (e) {
      quarantined.push({ guid: p.data.guid, reason: e instanceof Error ? e.message : String(e) });
      continue;
    }
    const jobGuid = p.data.jobReference?.guid ?? null;
    rows.push({
      toast_guid: p.data.guid,
      employee_guid: p.data.employeeReference?.guid ?? null,
      job_guid: jobGuid,
      job_title: jobGuid ? (jobTitles.get(jobGuid) ?? null) : null,
      business_date,
      clock_in: iso(p.data.inDate),
      clock_out: iso(p.data.outDate),
      regular_hours: h4(p.data.regularHours),
      overtime_hours: h4(p.data.overtimeHours),
      wage: p.data.hourlyWage == null ? null : new Decimal(p.data.hourlyWage).toFixed(4),
      tips_declared: m2(p.data.declaredCashTips),
      // cash gratuity / service charges paid out in cash; card tips + card gratuities
      cash_tips: m2(p.data.cashGratuityServiceCharges),
      non_cash_tips: p.data.nonCashTips == null && p.data.nonCashGratuityServiceCharges == null ? null : new Decimal(p.data.nonCashTips ?? 0).plus(p.data.nonCashGratuityServiceCharges ?? 0).toFixed(2),
      deleted: Boolean(p.data.deleted),
      toast_modified_at: iso(p.data.modifiedDate),
    });
  }
  return { rows, quarantined };
}

/** Job guid → title from GET /labor/v1/jobs (deleted jobs keep their title for history). */
export function parseJobTitles(raw: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(raw)) return out;
  for (const j of raw) {
    const p = JobSchema.safeParse(j);
    if (p.success && p.data.title) out.set(p.data.guid, p.data.title.trim());
  }
  return out;
}

export const LABOR_MAX_WINDOW_DAYS = 30;

/** Split [start, end] into windows Toast accepts (≤ 30 days each). */
export function planLaborWindows(start: Date, end: Date, maxDays = LABOR_MAX_WINDOW_DAYS): Array<{ start: Date; end: Date }> {
  const out: Array<{ start: Date; end: Date }> = [];
  const step = maxDays * 86_400_000;
  let s = start.getTime();
  const e = end.getTime();
  while (s < e) {
    const ce = Math.min(s + step, e);
    out.push({ start: new Date(s), end: new Date(ce) });
    s = ce;
  }
  return out;
}
