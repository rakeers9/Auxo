import { browser } from "wxt/browser";

import type { SettingsRequest, SettingsResult } from "../../src/settings/client";
import { renderSettings } from "../../src/settings/view";

const status = document.querySelector<HTMLElement>("#account-status")!;
const form = document.querySelector<HTMLFormElement>("#account-form")!;
const signedIn = document.querySelector<HTMLElement>("#signed-in")!;
const email = document.querySelector<HTMLElement>("#account-email")!;
const value = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!.value;

// All API calls go through the worker (it holds the session).
const settings = renderSettings(document.querySelector<HTMLElement>("#settings")!, {
  send: (request: SettingsRequest) => browser.runtime.sendMessage({ type: "auxo:settings", request }) as Promise<SettingsResult>,
});

async function showAccount(): Promise<void> {
  let account: { signedIn: boolean; email: string | null } = { signedIn: false, email: null };
  try {
    account = await browser.runtime.sendMessage({ type: "auxo:account" });
  } catch { /* shown as signed out */ }
  signedIn.hidden = !account.signedIn;
  form.hidden = account.signedIn;
  email.textContent = account.email ?? "your account";
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  status.textContent = "Signing in…";
  try {
    const result = await browser.runtime.sendMessage({ type: "auxo:login", url: value("url"), key: value("key"), email: value("email"), password: value("password") });
    status.textContent = result.ok ? "Signed in. Reload your shopping page." : "Sign-in failed. Check your account and public key.";
  } catch { status.textContent = "Could not connect."; }
  document.querySelector<HTMLInputElement>("#password")!.value = "";
  await showAccount();
  await settings.refresh();
});

document.querySelector("#logout")!.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "auxo:logout" });
  status.textContent = "Signed out.";
  await showAccount();
  await settings.refresh();
});

void showAccount();
