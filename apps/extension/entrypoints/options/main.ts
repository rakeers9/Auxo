import { browser } from "wxt/browser";
const status = document.querySelector<HTMLElement>("#status")!;
const value = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!.value;
document.querySelector("#login")!.addEventListener("submit", async (event) => {
  event.preventDefault(); status.textContent = "Signing in…";
  try {
    const result = await browser.runtime.sendMessage({ type: "auxo:login", url: value("url"), key: value("key"), email: value("email"), password: value("password") });
    status.textContent = result.ok ? "Connected. Reload your shopping page." : "Sign-in failed. Check your account and public key.";
  } catch { status.textContent = "Could not connect."; }
  document.querySelector<HTMLInputElement>("#password")!.value = "";
});
document.querySelector("#logout")!.addEventListener("click", async () => {
  await browser.runtime.sendMessage({ type: "auxo:logout" }); status.textContent = "Signed out.";
});
