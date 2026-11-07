import { ReadFailureReportSchema, type ReadFailureReport } from "@auxo/shared";

import type { KeyValueArea } from "./decision-memory";

// Reader failure reports (AUX-47), sent from the worker. Every failure is
// swallowed: the report is a to-do list for us, never part of the user's path.
export const READ_FAILURE_TIMEOUT_MS = 2_500;
// At most this many reports per hour from one browser, and each distinct
// failure once per day, so a broken page re-rendering can't flood the API.
export const READ_FAILURES_PER_HOUR = 20;
const KEY = "auxo:read-failures";
const AMAZON_HOST = "www.amazon.com";
const MESSAGE_KEYS = new Set(["type", "reader", "page_type", "codes"]);

// On in production builds; dev builds send only with WXT_REPORT_READ_FAILURES=1,
// so a developer's test pages don't fill the to-do list.
export function readFailureReportingEnabled(mode: string, flag: string | undefined): boolean {
  return mode !== "development" || flag === "1";
}

export function isReadFailureMessage(message: unknown): message is { type: "auxo:read-failure" } {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "auxo:read-failure";
}

// The report for a content script's message, or null if it isn't a valid one.
// Only the hostname of the sending page is used, and only Amazon's is sent:
// any other host would just say which shop the user visited.
export function buildReadFailureReport(
  message: unknown,
  context: { senderUrl: string | undefined; version: string; now: Date },
): ReadFailureReport | null {
  if (!isReadFailureMessage(message)) return null;
  // Exactly the message's own fields: anything more is a bug, not data to drop quietly.
  if (Object.keys(message).some((key) => !MESSAGE_KEYS.has(key))) return null;
  let host: string;
  try {
    host = new URL(context.senderUrl ?? "").hostname;
  } catch {
    return null;
  }
  const { reader, page_type, codes } = message as { reader?: unknown; page_type?: unknown; codes?: unknown };
  const amazon = typeof reader === "string" && reader.startsWith("amazon_");
  // An Amazon reader's report from any other page is not a real one.
  if (amazon && host !== AMAZON_HOST) return null;
  const parsed = ReadFailureReportSchema.safeParse({
    reader,
    page_type,
    codes,
    store_host: amazon ? AMAZON_HOST : null,
    extension_version: context.version,
    day: context.now.toISOString().slice(0, 10),
  });
  return parsed.success ? parsed.data : null;
}

interface LimiterState {
  day: string;
  sent: string[];
  hour: number;
  count: number;
}

export interface ReadFailureLimiter {
  // True (and counted) if this report may be sent now.
  allow(report: ReadFailureReport, now: Date): Promise<boolean>;
}

// Kept in the worker's session storage: the worker's memory is wiped when it
// goes idle, which would reset the limits.
export function createReadFailureLimiter(area: KeyValueArea, perHour = READ_FAILURES_PER_HOUR): ReadFailureLimiter {
  let queue: Promise<unknown> = Promise.resolve();
  return {
    allow(report, now) {
      const run = async () => {
        const stored = (await area.get(KEY))[KEY] as Partial<LimiterState> | undefined;
        const hour = Math.floor(now.getTime() / 3_600_000);
        const day = report.day;
        const state: LimiterState = {
          day,
          sent: stored?.day === day && Array.isArray(stored.sent) ? stored.sent.filter((s) => typeof s === "string") : [],
          hour,
          count: stored?.hour === hour && typeof stored.count === "number" ? stored.count : 0,
        };
        const signature = `${report.reader}|${report.page_type}|${report.codes.join(",")}`;
        if (state.sent.includes(signature) || state.count >= perHour) return false;
        await area.set({ [KEY]: { ...state, sent: [...state.sent, signature], count: state.count + 1 } });
        return true;
      };
      // One check at a time, so two messages can't both take the last slot.
      const result = queue.then(run, run);
      queue = result.catch(() => {});
      return result;
    },
  };
}

// POST /v1/read-failures. True on 2xx; false on anything else, never throws.
export async function postReadFailure(
  report: ReadFailureReport,
  options: { baseUrl: string; fetch?: typeof fetch; timeoutMs?: number },
): Promise<boolean> {
  const fetchFn = options.fetch ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? READ_FAILURE_TIMEOUT_MS);
  try {
    const response = await fetchFn(new URL("/v1/read-failures", options.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(report),
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// The worker's whole handling of one message: build, limit, post. Never throws.
export async function handleReadFailureMessage(
  message: unknown,
  deps: {
    senderUrl: string | undefined;
    version: string;
    now?: () => Date;
    limiter: ReadFailureLimiter;
    post: (report: ReadFailureReport) => Promise<boolean>;
  },
): Promise<boolean> {
  try {
    const now = deps.now?.() ?? new Date();
    const report = buildReadFailureReport(message, { senderUrl: deps.senderUrl, version: deps.version, now });
    if (!report || !(await deps.limiter.allow(report, now))) return false;
    return await deps.post(report);
  } catch {
    return false;
  }
}
