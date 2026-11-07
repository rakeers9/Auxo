import { readFailureReportingEnabled } from "./api/read-failures";

// Base URL of the Auxo API. Set WXT_API_BASE_URL at build time to override.
export const API_BASE_URL: string = import.meta.env.WXT_API_BASE_URL ?? "https://api-ten-sand-28.vercel.app";
// Reader failure codes go to the backend in production builds; dev builds
// send them only with WXT_REPORT_READ_FAILURES=1 (AUX-47).
export const REPORT_READ_FAILURES = readFailureReportingEnabled(import.meta.env.MODE, import.meta.env.WXT_REPORT_READ_FAILURES);
