import type { Reader, ReadFailurePageType } from "@auxo/shared";

import { failureCodes } from "../cart/codes";
import type { ReadFailureMessage } from "../messages";

export type ReadFailureNotifier = (reader: Reader | null, pageType: ReadFailurePageType, problems: readonly string[]) => void;

// One per page load (content script instance). Pages are re-read on every
// change, so each distinct failure (reader, page type, codes) is sent once.
// Never throws and never waits: reporting must not slow or block the page.
export function createReadFailureNotifier(send: (message: ReadFailureMessage) => void): ReadFailureNotifier {
  const sent = new Set<string>();
  return (reader, pageType, problems) => {
    if (reader === null) return;
    const codes = failureCodes(reader, problems);
    if (codes.length === 0) return;
    const key = `${reader}|${pageType}|${codes.join(",")}`;
    if (sent.has(key)) return;
    sent.add(key);
    try {
      send({ type: "auxo:read-failure", reader, page_type: pageType, codes });
    } catch {
      // The worker may be restarting; a dropped report is fine.
    }
  };
}
