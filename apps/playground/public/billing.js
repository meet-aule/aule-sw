// The guardian's billing controls. Provider redirects never stand in for a receipt.
import { $, call } from "./students.js";
import { current, getAccount, onAccount, onShow } from "./screens.js";
import { language, locale, onLanguage, t } from "./i18n.js";

let state = null;
let busy = false;
let generation = 0;
function message(key) { $("billing-state").textContent = t(`billing.${key}`); }
function draw() {
  if (!state) return;
  const status = state.subscription?.status ?? "none";
  message(state.free_access ? "free" : !state.available ? "unavailable" : status);
  $("billing-offer").hidden = !state.available || state.free_access || state.included_until || ["authorized", "paused", "creating"].includes(status);
  if (state.included_until && !state.free_access) message("included");
  $("billing-cancel").hidden = !state.available || !state.subscription || Boolean(state.subscription.cancelled_at);
  $("billing-history").replaceChildren(...(state.payments ?? []).map((payment) => {
    const line = document.createElement("li");
    const status = ["approved", "rejected", "refunded", "charged_back", "pending", "in_process", "cancelled"].includes(payment.status) ? payment.status : "unknown";
    const amount = new Intl.NumberFormat(locale(), { style: "currency", currency: payment.currency }).format(payment.amount_cents / 100);
    line.textContent = `${amount} · ${t(`billing.${status}`)}${payment.approved_at ? ` · ${new Date(payment.approved_at).toLocaleDateString(locale())}` : ""}`;
    return line;
  }));
  $("billing-devices").replaceChildren(...(state.devices ?? []).map((device) => {
    const line = document.createElement("li");
    if (device.activated_at) { line.textContent = t("billing.activated"); return line; }
    if (state.free_access) { line.textContent = t("billing.reserved", { months: device.included_months }); return line; }
    const button = document.createElement("button");
    button.type = "button"; button.className = "link";
    button.textContent = t("billing.redeem", { months: device.included_months });
    button.addEventListener("click", () => {
      if (window.confirm(t("billing.confirm_redeem"))) act("redeem", { order_id: device.id, cancel_renewal: true });
    });
    line.append(button); return line;
  }));
}
async function read(refresh = false) {
  const request = ++generation;
  try {
    const result = await call(refresh ? "api/billing/refresh" : "api/billing", refresh ? {} : undefined);
    if (request !== generation || current() !== "home" || getAccount().signed_in !== true) return;
    state = result; draw();
  } catch { if (request === generation) message("error"); }
}
async function act(action, body = {}) {
  if (busy) return;
  busy = true;
  const request = generation;
  const buttons = [...$("billing-panel").querySelectorAll("button")];
  buttons.forEach((b) => { b.disabled = true; });
  message("checking");
  try {
    const result = await call(`api/billing/${action}`, { ...body, language: language() });
    if (request !== generation || getAccount().signed_in !== true) return;
    if (action === "subscribe" && typeof result.checkout_url === "string") {
      const url = new URL(result.checkout_url);
      if (url.protocol !== "https:" || !["www.mercadopago.com.pe", "sandbox.mercadopago.com.pe"].includes(url.hostname) || url.username || url.password) throw new Error("invalid checkout");
      window.location.assign(url.href); return;
    }
    await read();
  } catch { if (request === generation) message("error"); }
  finally { busy = false; buttons.forEach((b) => { b.disabled = false; }); }
}
$("billing-panel").addEventListener("toggle", () => { if ($("billing-panel").open) read(); });
$("billing-refresh").addEventListener("click", async () => { await read(true); setTimeout(() => { if (current() === "home") read(); }, 2500); });
$("billing-subscribe").addEventListener("click", () => {
  if (!$("billing-consent").checked) { message("accept"); return; }
  act("subscribe", { accept_recurring: true });
});
$("billing-cancel").addEventListener("click", () => { if (window.confirm(t("billing.confirm_cancel"))) act("cancel"); });
onShow("home", () => {
  if (new URLSearchParams(location.search).get("billing") === "return") $("billing-panel").open = true;
  if ($("billing-panel").open) read(true);
});
onAccount(() => { if (getAccount().signed_in !== true) { generation++; state = null; $("billing-history").replaceChildren(); $("billing-devices").replaceChildren(); $("billing-consent").checked = false; $("billing-panel").open = false; } });
onLanguage(draw);
