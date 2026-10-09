import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { browser } from "wxt/browser";

const CONFIG_KEY = "auxo:auth-config";
let client: SupabaseClient | null = null;
export async function authClient(): Promise<SupabaseClient | null> {
  if (client) return client;
  const saved = (await browser.storage.local.get(CONFIG_KEY))[CONFIG_KEY] as { url: string; key: string } | undefined;
  if (!saved) return null;
  client = createClient(saved.url, saved.key, { auth: {
    persistSession: true, autoRefreshToken: false, detectSessionInUrl: false,
    storage: {
      getItem: async (key) => (await browser.storage.local.get(key))[key] as string ?? null,
      setItem: async (key, value) => { await browser.storage.local.set({ [key]: value }); },
      removeItem: async (key) => { await browser.storage.local.remove(key); },
    },
  } });
  return client;
}

export async function configureAuth(url: string, key: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !parsed.hostname.endsWith(".supabase.co")) throw new Error("Use the HTTPS Supabase project URL.");
  if (!key.trim()) throw new Error("A public Supabase key is required.");
  await (await authClient())?.auth.signOut();
  await browser.storage.local.set({ [CONFIG_KEY]: { url: parsed.origin, key } });
  client = null;
}

// Runs only in the background worker. Refresh on each request when necessary;
// this also works after Chrome has suspended and restarted the worker.
export const authenticatedFetch: typeof fetch = async (input, init) => {
  const auth = await authClient();
  if (!auth) throw new Error("Sign in through Auxo's options page.");
  const { data, error } = await auth.auth.getSession();
  if (error || !data.session) throw new Error("Sign in required.");
  const send = (token: string) => {
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  const response = await send(data.session.access_token);
  if (response.status !== 401) return response;
  const refreshed = await auth.auth.refreshSession();
  if (refreshed.error || !refreshed.data.session) return response;
  return send(refreshed.data.session.access_token);
};
