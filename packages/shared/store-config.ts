import { z } from "zod";

import { TriggerIntentSchema } from "./trigger.js";

// Store selectors are served by the backend as DATA (allowed in Manifest V3),
// so a store that changes its HTML can be fixed in minutes without a Chrome
// Web Store release. The extension ships defaults for every selector; the
// backend only sends overrides, plus a per-store on/off switch.

const SelectorListSchema = z.array(z.string().trim().min(1).max(300)).min(1).max(20);

export const StoreOverridesSchema = z
  .object({
    // false turns the store off: the extension reads and decides nothing there.
    enabled: z.boolean(),
    // Known buy-intent buttons, by intent. Replaces the bundled list for that intent.
    buttons: z.partialRecord(TriggerIntentSchema.exclude(["page_view"]), SelectorListSchema).optional(),
    // Page reader selectors, by the reader's own key names. Replaces the bundled value.
    selectors: z.record(z.string().trim().min(1).max(100), z.string().trim().min(1).max(300)).optional(),
  })
  .strict();

export const StoreConfigSchema = z
  .object({
    // Changes whenever any store's overrides change.
    version: z.string().trim().min(1).max(100),
    // Keyed by hostname, e.g. "www.amazon.com".
    stores: z.record(z.string().trim().min(1).max(253), StoreOverridesSchema),
  })
  .strict();

export type StoreOverrides = z.infer<typeof StoreOverridesSchema>;
export type StoreConfig = z.infer<typeof StoreConfigSchema>;
