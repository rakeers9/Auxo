import { enforcementEnabled } from "./tracking/gate";

// One feature flag for every popup the extension puts on a page (the pause and
// block overlay, the verdict overlay, the click-again hint, the generic
// checkout pause) and for click blocking. Off by default: the extension only
// reads and reports. Build with WXT_ENFORCE=1. Any new on-page popup must
// check it.
export const ENFORCE = enforcementEnabled(import.meta.env.WXT_ENFORCE);
