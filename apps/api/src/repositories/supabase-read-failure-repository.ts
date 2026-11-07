import type { SupabaseClient } from "@supabase/supabase-js";
import type { ReadFailureReport } from "@auxo/shared";

import type { ReadFailureRepository } from "./read-failure-repository.js";

// The read_failures table has RLS on and no policies, so only this
// service-role client writes it; the read_failure_ranking view reads it.
export class SupabaseReadFailureRepository implements ReadFailureRepository {
  public constructor(private readonly client: SupabaseClient) {}

  public async record(report: ReadFailureReport): Promise<void> {
    const { error } = await this.client.from("read_failures").insert({
      day: report.day,
      reader: report.reader,
      page_type: report.page_type,
      store_host: report.store_host,
      extension_version: report.extension_version,
      codes: report.codes,
    });
    if (error) throw new Error("Unable to record the read failure.", { cause: error });
  }
}
