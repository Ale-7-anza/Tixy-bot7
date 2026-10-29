// Webhook de Meta para WhatsApp e Instagram.
// URL para Meta: https://<dominio-del-proyecto>/api/meta/webhook
import { waitUntil } from "@vercel/functions";
import { isValidSignature, extractEvents, sendReply, sendInstagramPrivateReply } from "../../../../lib/meta.js";
import { claimEvent } from "../../../../lib/db.js";
import { handleIncoming, FALLBACK_REPLY } from "../../../../lib/agent.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const UNSUPPORTED_REPLY = "Por ahora solo puedo leer mensajes de texto ✍️ ¿Me lo escribís?";
const DEFAULT_COMMENT_REPLY =
  "¡Hola! 👋 Soy Tixy, de TixPays. Contame: ¿querés info de un evento o estás organizando uno? Te ayudo por acá.";

// Verificación: Meta llama con GET una sola vez al configurar el webhook.
export async function GET(req) {
  const p = new URL(req.url).searchParams;
  const expected = (process.env.META_VERIFY_TOKEN || "").trim();
  if (p.get("hub.mode") === "subscribe" && expected && p.get("hub.verify_token") === expected) {
    return new Response(p.get("hub.challenge") ?? "", { status: 200, headers: { "content-type": "text/plain" } });
  }
  return new Response("Forbidden", { status: 403 });
}

// Eventos: se responde 200 al instante y se procesa en segundo plano.
export async function POST(req) {
  const raw = Buffer.from(await req.arrayBuffer());
  if (!isValidSignature(raw, req.headers.get("x-hub-signature-256"))) {
    return new Response("Invalid signature", { status: 401 });
  }
  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  if (process.env.BOT_ENABLED === "true") {
    waitUntil(processEvents(body).catch((err) => console.error("[Tixy]", err)));
  }
  return new Response("EVENT_RECEIVED", { status: 200 });
}

async function processEvents(body) {
  for (const ev of extractEvents(body)) {
    try {
      if (!(await claimEvent(ev.mid))) continue; // reintento de Meta

      if (ev.kind === "comment") {
        await sendInstagramPrivateReply(ev.commentId, process.env.IG_COMMENT_REPLY || DEFAULT_COMMENT_REPLY);
        continue;
      }
      if (ev.unsupported) {
        await sendReply(ev, UNSUPPORTED_REPLY);
        continue;
      }

      let reply;
      try {
        reply = await handleIncoming(ev);
      } catch (err) {
        console.error(`[Tixy] error generando respuesta (${ev.channel}):`, err.message);
        reply = FALLBACK_REPLY;
      }
      if (reply) await sendReply(ev, reply);
    } catch (err) {
      console.error(`[Tixy] error procesando ${ev.channel}:${ev.mid}:`, err.message);
    }
  }
}
