import {
  BudgetSchema,
  CreateBudgetSchema,
  CreateRuleSchema,
  RuleSchema,
  UpdateBudgetSchema,
  UpdateRuleSchema,
  type Budget,
  type CreateBudget,
  type CreateRule,
  type Rule,
  type UpdateBudget,
  type UpdateRule,
} from "@auxo/shared";
import { z } from "zod";

import { SignedOutError } from "../api/session";

// What the Options page can ask the worker to do with the user's rules and
// budgets (AUX-50). The worker makes the API call; the page never does.
export type SettingsRequest =
  | { op: "list" }
  | { op: "create-rule"; rule: CreateRule }
  | { op: "update-rule"; id: string; update: UpdateRule }
  | { op: "delete-rule"; id: string }
  | { op: "create-budget"; budget: CreateBudget }
  | { op: "update-budget"; id: string; update: UpdateBudget }
  | { op: "delete-budget"; id: string };

export type SettingsFailure = "signed_out" | "invalid" | "http" | "network" | "invalid_response";

// Every answer carries the whole list again, so the page just redraws it.
export type SettingsResult =
  | { ok: true; rules: Rule[]; budgets: Budget[] }
  | { ok: false; reason: SettingsFailure; message?: string };

const IdSchema = z.string().uuid();

const SettingsRequestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("list") }).strict(),
  z.object({ op: z.literal("create-rule"), rule: CreateRuleSchema }).strict(),
  z.object({ op: z.literal("update-rule"), id: IdSchema, update: UpdateRuleSchema }).strict(),
  z.object({ op: z.literal("delete-rule"), id: IdSchema }).strict(),
  z.object({ op: z.literal("create-budget"), budget: CreateBudgetSchema }).strict(),
  z.object({ op: z.literal("update-budget"), id: IdSchema, update: UpdateBudgetSchema }).strict(),
  z.object({ op: z.literal("delete-budget"), id: IdSchema }).strict(),
]);

export function isSettingsMessage(message: unknown): message is { type: "auxo:settings"; request: unknown } {
  return typeof message === "object" && message !== null && (message as { type?: unknown }).type === "auxo:settings";
}

// Checks a request from the page against the shared contracts.
export function parseSettingsRequest(request: unknown): SettingsRequest | null {
  const parsed = SettingsRequestSchema.safeParse(request);
  return parsed.success ? (parsed.data as SettingsRequest) : null;
}

export interface SettingsClientOptions {
  baseUrl: string;
  fetch: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

const RulesResponseSchema = z.object({ rules: z.array(RuleSchema) });
const BudgetsResponseSchema = z.object({ budgets: z.array(BudgetSchema) });
const ApiErrorSchema = z.object({ error: z.object({ message: z.string() }) });

class SettingsError extends Error {
  public constructor(public readonly reason: SettingsFailure, message?: string) {
    super(message ?? reason);
  }
}

export async function runSettingsRequest(raw: unknown, options: SettingsClientOptions): Promise<SettingsResult> {
  const request = parseSettingsRequest(raw);
  if (!request) return { ok: false, reason: "invalid" };
  try {
    await send(request, options);
    const [rules, budgets] = await Promise.all([
      call(options, "GET", "/v1/rules").then((body) => parse(RulesResponseSchema, body).rules),
      call(options, "GET", "/v1/budgets").then((body) => parse(BudgetsResponseSchema, body).budgets),
    ]);
    return { ok: true, rules, budgets };
  } catch (error) {
    if (error instanceof SettingsError) {
      return error.message === error.reason ? { ok: false, reason: error.reason } : { ok: false, reason: error.reason, message: error.message };
    }
    return { ok: false, reason: error instanceof SignedOutError ? "signed_out" : "network" };
  }
}

async function send(request: SettingsRequest, options: SettingsClientOptions): Promise<void> {
  switch (request.op) {
    case "list":
      return;
    case "create-rule":
      await call(options, "POST", "/v1/rules", request.rule);
      return;
    case "update-rule":
      await call(options, "PATCH", `/v1/rules/${request.id}`, request.update);
      return;
    case "delete-rule":
      await call(options, "DELETE", `/v1/rules/${request.id}`);
      return;
    case "create-budget":
      await call(options, "POST", "/v1/budgets", request.budget);
      return;
    case "update-budget":
      await call(options, "PATCH", `/v1/budgets/${request.id}`, request.update);
      return;
    case "delete-budget":
      await call(options, "DELETE", `/v1/budgets/${request.id}`);
      return;
  }
}

async function call(options: SettingsClientOptions, method: string, path: string, body?: unknown): Promise<unknown> {
  const response = await options.fetch(new URL(path, options.baseUrl), {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (response.status === 401) throw new SettingsError("signed_out");
  if (!response.ok) {
    const error = ApiErrorSchema.safeParse(await response.json().catch(() => null));
    throw new SettingsError("http", error.success ? error.data.error.message : undefined);
  }
  if (response.status === 204) return null;
  return response.json().catch(() => {
    throw new SettingsError("invalid_response");
  });
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new SettingsError("invalid_response");
  return parsed.data;
}
