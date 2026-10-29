// Meta: firma de webhooks, parser de eventos y envío por WhatsApp Cloud API / Instagram.
import crypto from "crypto";
import { splitText } from "./format.js";

const TIMEOUT_MS = 20000;
const version = () => process.env.META_GRAPH_VERSION || "v26.0";

// ---------- Firma ----------
// Meta firma cada POST con HMAC-SHA256 del body crudo. La app de Meta y la de Instagram
// tienen secrets distintos: se acepta cualquiera de los dos.
export const isValidSignature = (rawBody, header, secrets = [process.env.META_APP_SECRET, process.env.IG_APP_SECRET]) => {
  const keys = secrets.map((s) => (s || "").trim()).filter(Boolean);
  if (!keys.length || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const received = Buffer.from(header.slice(7).toLowerCase(), "utf8");
  return keys.some((key) => {
    const expected = Buffer.from(crypto.createHmac("sha256", key).update(rawBody).digest("hex"), "utf8");
    return expected.length === received.length && crypto.timingSafeEqual(expected, received);
  });
};

// ---------- Parser ----------
export const commentKeywords = () =>
  (process.env.IG_COMMENT_KEYWORDS || "ENTRADA,ENTRADAS,INFO,DEMO")
    .split(",").map((k) => k.trim().toUpperCase()).filter(Boolean);

export const extractEvents = (body, keywords = commentKeywords()) => {
  const events = [];

  if (body?.object === "whatsapp_business_account") {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== "messages") continue;
        const v = change.value || {};
        const profileName = v.contacts?.[0]?.profile?.name || "";
        for (const m of v.messages || []) {
          const text =
            m.type === "text" ? m.text?.body
            : m.type === "button" ? m.button?.text
            : m.type === "interactive" ? (m.interactive?.button_reply?.title || m.interactive?.list_reply?.title)
            : null;
          events.push({
            kind: "message", channel: "whatsapp", mid: m.id, userId: m.from,
            text: text || null, unsupported: !text, profileName, phoneNumberId: v.metadata?.phone_number_id,
          });
        }
      }
    }
  }

  if (body?.object === "instagram") {
    for (const entry of body.entry || []) {
      const ownId = String(entry.id || "");
      for (const ev of entry.messaging || []) {
        const msg = ev.message;
        if (!msg || msg.is_echo || String(ev.sender?.id) === ownId) continue;
        events.push({
          kind: "message", channel: "instagram", mid: msg.mid, userId: String(ev.sender?.id || ""),
          text: msg.text || null, unsupported: !msg.text, profileName: "",
        });
      }
      for (const change of entry.changes || []) {
        if (change.field !== "comments") continue;
        const v = change.value || {};
        if (String(v.from?.id) === ownId) continue;
        const upper = String(v.text || "").toUpperCase();
        if (keywords.some((k) => upper.includes(k))) {
          events.push({ kind: "comment", channel: "instagram", mid: `comment_${v.id}`, commentId: v.id });
        }
      }
    }
  }

  return events.filter((e) => e.mid && (e.kind === "comment" || e.userId));
};

// ---------- Envío ----------
const graphPost = async (url, token, payload) => {
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`Graph API ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json().catch(() => ({}));
};

export const sendWhatsAppText = async (to, text, phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID) => {
  const url = `https://graph.facebook.com/${version()}/${phoneNumberId}/messages`;
  for (const body of splitText(text, 4000)) {
    await graphPost(url, process.env.WHATSAPP_ACCESS_TOKEN, {
      messaging_product: "whatsapp", to, type: "text", text: { body, preview_url: true },
    });
  }
};

export const sendInstagramText = async (recipientId, text) => {
  const url = `https://graph.instagram.com/${version()}/me/messages`;
  for (const part of splitText(text, 1000)) {
    await graphPost(url, process.env.IG_ACCESS_TOKEN, { recipient: { id: recipientId }, message: { text: part } });
  }
};

// Respuesta privada (DM) a un comentario: una por comentario, dentro de los 7 días.
export const sendInstagramPrivateReply = (commentId, text) =>
  graphPost(`https://graph.instagram.com/${version()}/me/messages`, process.env.IG_ACCESS_TOKEN, {
    recipient: { comment_id: commentId },
    message: { text: String(text || "").slice(0, 1000) },
  });

export const sendReply = (ev, text) =>
  ev.channel === "whatsapp" ? sendWhatsAppText(ev.userId, text, ev.phoneNumberId || undefined) : sendInstagramText(ev.userId, text);
