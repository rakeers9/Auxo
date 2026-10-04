import { z } from "zod";

const EnvironmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().max(65_535).default(3001),
  CORS_ORIGINS: z.string().default(""),
  AUTH_MODE: z.enum(["development", "required"]).default("development"),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().min(1).optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  DECISION_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
  TYPESAFE_API_KEY: z.string().min(1).optional(),
  TYPESAFE_BASE_URL: z.string().url().optional(),
  TYPESAFE_DEFAULT_MODEL: z.string().min(1).default("jev-latest"),
  JEV_TIMEOUT_MS: z.coerce.number().int().positive().max(30_000).default(2_000),
});

export interface ApiConfig {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  corsOrigins: string[];
  authMode: "development" | "required";
  supabaseUrl: string | undefined;
  supabaseAnonKey: string | undefined;
  supabaseServiceRoleKey: string | undefined;
  decisionTtlSeconds: number;
  typesafeApiKey: string | undefined;
  typesafeBaseUrl: string | undefined;
  typesafeDefaultModel: string;
  jevTimeoutMs: number;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = EnvironmentSchema.parse(environment);
  const corsOrigins = parsed.CORS_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (parsed.NODE_ENV === "production" && corsOrigins.length === 0) {
    throw new Error("CORS_ORIGINS must contain at least one origin in production.");
  }

  if (parsed.NODE_ENV === "production" && parsed.AUTH_MODE !== "required") {
    throw new Error("AUTH_MODE must be required in production.");
  }

  const supabaseValues = [
    parsed.SUPABASE_URL,
    parsed.SUPABASE_ANON_KEY,
    parsed.SUPABASE_SERVICE_ROLE_KEY,
  ];
  const configuredSupabaseValues = supabaseValues.filter(Boolean).length;

  if (configuredSupabaseValues > 0 && configuredSupabaseValues < supabaseValues.length) {
    throw new Error(
      "SUPABASE_URL, SUPABASE_ANON_KEY, and SUPABASE_SERVICE_ROLE_KEY must be configured together.",
    );
  }

  if (parsed.AUTH_MODE === "required" && configuredSupabaseValues === 0) {
    throw new Error("Supabase credentials are required when AUTH_MODE is required.");
  }

  return {
    nodeEnv: parsed.NODE_ENV,
    host: parsed.HOST,
    port: parsed.PORT,
    corsOrigins,
    authMode: parsed.AUTH_MODE,
    supabaseUrl: parsed.SUPABASE_URL,
    supabaseAnonKey: parsed.SUPABASE_ANON_KEY,
    supabaseServiceRoleKey: parsed.SUPABASE_SERVICE_ROLE_KEY,
    decisionTtlSeconds: parsed.DECISION_TTL_SECONDS,
    typesafeApiKey: parsed.TYPESAFE_API_KEY,
    typesafeBaseUrl: parsed.TYPESAFE_BASE_URL,
    typesafeDefaultModel: parsed.TYPESAFE_DEFAULT_MODEL,
    jevTimeoutMs: parsed.JEV_TIMEOUT_MS,
  };
}
