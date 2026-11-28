import { $, get, say, signOutButton } from "./common.js";
import { day } from "./labels.js";
signOutButton();
const status = { approved: "Pago aprobado", pending: "Pago pendiente", creating: "Confirmando checkout", rejected: "Pago rechazado", refunded: "Reembolsado", charged_back: "Contracargo", cancelled: "Cancelado", in_process: "Pago en proceso" };
async function read() {
  $("refresh").disabled = true;
  try {
    const data = await get("/api/orders");
    $("count").textContent = `${data.orders.length} pedidos recientes`;
    $("orders").replaceChildren(...data.orders.map((order) => {
      const article = document.createElement("article");
      const title = document.createElement("h3"); title.textContent = order.id;
      const summary = document.createElement("p"); summary.textContent = `${day(order.created_at)} · ${status[order.status] ?? order.status} · ${order.quantity} unidades · S/ ${(order.amount_cents / 100).toFixed(2)}`;
      const details = document.createElement("dl");
      for (const [key, label] of [["nombres", "Nombres"], ["apellidos", "Apellidos"], ["email", "Correo"], ["telefono", "Teléfono"], ["direccion", "Dirección"], ["distrito", "Distrito"], ["provincia", "Provincia"], ["departamento", "Departamento"], ["referencia", "Referencia"], ["comprobante", "Comprobante"], ["documento", "DNI/RUC"], ["razonSocial", "Razón social"]]) {
        const term = document.createElement("dt"); term.textContent = label;
        const value = document.createElement("dd"); value.textContent = order.buyer[key] || "—";
        details.append(term, value);
      }
      article.append(title, summary, details); return article;
    }));
  } catch (error) { say(error.message); }
  finally { $("refresh").disabled = false; }
}
$("refresh").addEventListener("click", read);
void read();
