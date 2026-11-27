// A GET never changes preferences: mail scanners routinely open every link.
// The POST needs only the signed, limited capability, never a login cookie.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Settings } from "./config.ts";

export const TOKEN = /^[a-f0-9]{32}\.[0-9]{10}\.(es|en)\.[a-f0-9]{64}$/;

export async function unsubscribe(
  request: IncomingMessage, response: ServerResponse, settings: Settings, url: URL,
): Promise<void> {
  const token = url.searchParams.get("token") ?? "";
  const en = TOKEN.exec(token)?.[1] === "en";
  const send = (status: number, title: string, detail: string, form = false) => {
    response.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(request.method === "HEAD" ? undefined : `<!doctype html><html lang="${en ? "en" : "es"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Aule</title><body style="margin:0;padding:40px 20px;background:#f5f4ed;color:#242521;font:18px/1.6 Arial,sans-serif"><main style="max-width:540px;margin:8vh auto"><p style="font:bold 34px Georgia,serif">Aule</p><h1 style="font:36px/1.15 Georgia,serif">${title}</h1><p>${detail}</p>${form ? `<form method="post"><input type="hidden" name="List-Unsubscribe" value="One-Click"><button style="border:0;border-radius:10px;padding:16px 24px;background:#242521;color:#f5f4ed;font:18px Arial,sans-serif;cursor:pointer">${en ? "Unsubscribe" : "Dejar de recibir avisos"}</button></form>` : ""}</main></body></html>`);
  };
  if (!TOKEN.test(token)) return send(400, en ? "Invalid link" : "Enlace no válido", en ? "Open the link in a recent Aule email." : "Abre el enlace de un correo reciente de Aule.");
  if (request.method === "GET" || request.method === "HEAD") {
    return send(200, en ? "Email notices" : "Avisos por correo", en
      ? "Stop receiving session summaries and attention notices by email. They will remain in Aule. Your account, sign-in codes and phone notifications will stay active."
      : "Dejarás de recibir resúmenes de sesión y avisos de atención por correo. Seguirán disponibles en Aule. Tu cuenta, los códigos de acceso y las notificaciones del teléfono seguirán activos.", true);
  }
  if (request.method !== "POST") return send(405, en ? "Method not allowed" : "Método no permitido", "");
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > 1024) return send(413, en ? "Request too large" : "Solicitud demasiado grande", "");
  }
  if (!settings.platform) return send(503, en ? "Try again later" : "Inténtalo más tarde", "");
  try {
    const result = await fetch(`${settings.platform.url}/v1/notices/unsubscribe`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }), signal: AbortSignal.timeout(10_000), redirect: "error",
    });
    if (!result.ok) return send(result.status >= 500 ? 503 : 400, en ? "Could not unsubscribe" : "No se pudo guardar la baja", en ? "Try again, or open the link in a more recent email." : "Inténtalo de nuevo o abre el enlace de un correo más reciente.");
    return send(200, en ? "Email notices turned off" : "Avisos por correo desactivados", en ? "Your account stays active. You can still read notices in Aule." : "Tu cuenta sigue activa. Puedes seguir leyendo los avisos en Aule.");
  } catch {
    return send(503, en ? "Try again later" : "Inténtalo más tarde", en ? "Your preference could not be saved." : "No se pudo guardar tu preferencia.");
  }
}
