import type { ReadFailureReport } from "@auxo/shared";

// Reader failure reports (AUX-47). Stored as sent: no user, no time beyond the
// report's own day, so a row can't be tied back to anyone.
export interface ReadFailureRepository {
  record(report: ReadFailureReport): Promise<void>;
}

export class InMemoryReadFailureRepository implements ReadFailureRepository {
  public readonly reports: ReadFailureReport[] = [];

  public async record(report: ReadFailureReport): Promise<void> {
    this.reports.push(report);
  }
}
