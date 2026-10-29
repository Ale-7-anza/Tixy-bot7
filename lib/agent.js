// Cerebro de Tixy: historial por usuario + Claude con herramientas.
// Lee TixPays (solo lectura) y escribe únicamente en la base propia del bot.
import { getBotDb } from "./db.js";
import { searchEvents, getEventDetails, getPurchasesByPhone } from "./tixpays.js";
import { sendWhatsAppText } from "./meta.js";
import { buildSystemPrompt } from "./prompt.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const HISTORY_TURNS = 20;
const STORED_MESSAGES = 60;
const MAX_TOOL_ROUNDS = 6;

export const FALLBACK_REPLY = "¡Gracias por escribirnos! 🙌 En breve te responde alguien del equipo TixPays.";

const COMMON_TOOLS = [
  {
    name: "buscar_eventos",
    description: "Lista eventos publicados próximos de TixPays (nombre, productora, fecha, lugar, link). Opcionalmente filtra por texto en nombre o lugar.",
    input_schema: { type: "object", properties: { texto: { type: "string", description: "Parte del nombre del evento o del lugar" } } },
  },
  {
    name: "detalle_evento",
    description: "Detalle de un evento: tipos de entrada con precio, cargo de servicio y disponibilidad, y consumiciones a la venta. Requiere el evento_id que devuelve buscar_eventos.",
    input_schema: { type: "object", properties: { evento_id: { type: "string" } }, required: ["evento_id"] },
  },
  {
    name: "registrar_lead",
    description: "Guarda o actualiza datos de calificación de un ORGANIZADOR. Llamala con cada dato nuevo. Devuelve el nivel (A/B/C) y el link de demo.",
    input_schema: {
      type: "object",
      properties: {
        productora: { type: "string" },
        contacto: { type: "string" },
        email: { type: "string" },
        tipo_evento: { type: "string", description: "Fiesta, Festival, Recital, Corporativo, Deportivo, Otro" },
        asistentes: { type: "integer" },
        recurrente: { type: "boolean" },
        canales: { type: "string" },
        dolor: { type: "string" },
      },
    },
  },
  {
    name: "escalar_a_humano",
    description: "Deriva la conversación a una persona del equipo (reclamos, pagos, reembolsos, lo que no puedas resolver o si piden hablar con alguien). Después el bot deja de responder esa conversación.",
    input_schema: {
      type: "object",
      properties: { motivo: { type: "string" }, urgencia: { type: "string", enum: ["alta", "normal"] } },
      required: ["motivo"],
    },
  },
];

const WHATSAPP_ONLY_TOOLS = [
  {
    name: "mis_compras",
    description: "Compras de entradas y consumiciones de los últimos 120 días asociadas al número de WhatsApp que está escribiendo. No requiere parámetros.",
    input_schema: { type: "object", properties: {} },
  },
];

export const toolsFor = (channel) => (channel === "whatsapp" ? [...COMMON_TOOLS, ...WHATSAPP_ONLY_TOOLS] : COMMON_TOOLS);

// Mismos criterios que la planilla "Calificación B2B".
export const calcularNivel = ({ asistentes, tipoEvento, recurrente } = {}) => {
  const minA = Number(process.env.LEAD_MIN_A) || 1500;
  const minB = Number(process.env.LEAD_MIN_B) || 300;
  const has = typeof asistentes === "number" && Number.isFinite(asistentes);
  if ((has && asistentes >= minA) || String(tipoEvento || "").toLowerCase() === "festival") return "A";
  if (!has) return null;
  if (asistentes >= minB && recurrente === true) return "B";
  return "C";
};

const NEXT_STEP = {
  A: "Prioridad alta: proponé demo en las próximas 24 h.",
  B: "Proponé demo dentro de la semana.",
  C: "Ofrecé la prueba real en su próximo evento y el material informativo.",
};

const callClaudeDefault = async (body) => {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`Anthropic API ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
};

const clean = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== ""));

export const createToolRunner = ({ getDb = getBotDb, tixpays = { searchEvents, getEventDetails, getPurchasesByPhone } } = {}) =>
  async (name, input, ctx) => {
    if (name === "buscar_eventos") {
      const eventos = await tixpays.searchEvents(input);
      return { eventos, total: eventos.length };
    }
    if (name === "detalle_evento") return tixpays.getEventDetails(input);
    if (name === "mis_compras") {
      if (ctx.channel !== "whatsapp") return { error: "Solo disponible por WhatsApp" };
      return tixpays.getPurchasesByPhone(ctx.userId);
    }

    const db = await getDb();
    const key = { channel: ctx.channel, userId: ctx.userId };

    if (name === "registrar_lead") {
      const update = clean({
        productora: input.productora,
        contacto: input.contacto,
        email: input.email,
        tipoEvento: input.tipo_evento,
        asistentes: Number.isInteger(input.asistentes) ? input.asistentes : undefined,
        recurrente: typeof input.recurrente === "boolean" ? input.recurrente : undefined,
        canales: input.canales,
        dolor: input.dolor,
      });
      const prev = (await db.collection("leads").findOne(key)) || {};
      const nivel = calcularNivel({ ...prev, ...update });
      await db.collection("leads").updateOne(
        key,
        {
          $set: { ...update, nivel, perfil: ctx.profileName || prev.perfil || "", updatedAt: new Date(), ...(ctx.channel === "whatsapp" ? { whatsapp: ctx.userId } : {}) },
          $setOnInsert: { estado: "Nuevo", createdAt: new Date() },
        },
        { upsert: true }
      );
      return { ok: true, nivel, demo_link: process.env.DEMO_URL || null, indicacion: NEXT_STEP[nivel] || "Faltan datos: seguí calificando (asistentes, recurrencia)." };
    }

    if (name === "escalar_a_humano") {
      await db.collection("conversations").updateOne(
        key,
        { $set: { humanTakeover: true, takeoverAt: new Date(), takeoverReason: String(input.motivo || "").slice(0, 500) } },
        { upsert: true }
      );
      await db.collection("alerts").insertOne({ ...key, ...input, profileName: ctx.profileName || "", createdAt: new Date() });
      const owner = (process.env.OWNER_WHATSAPP || "").replace(/\D/g, "");
      if (owner) {
        // Solo llega si el dueño le escribió al número del bot en las últimas 24 h (regla de Meta).
        await sendWhatsAppText(owner, `🚨 Derivación TixPays (${input.urgencia || "normal"})\nCanal: ${ctx.channel}\nUsuario: ${ctx.profileName || ctx.userId}\nMotivo: ${input.motivo}`)
          .catch((err) => console.warn("[Tixy] aviso al dueño falló:", err.message));
      }
      return { ok: true, mensaje: "Derivado. Avisale que una persona del equipo lo contacta a la brevedad." };
    }

    return { error: "herramienta desconocida" };
  };

/**
 * Procesa un mensaje entrante y devuelve el texto a responder, o null si la conversación
 * está derivada a una persona. ctx = { channel, userId, text, profileName }
 */
export const handleIncoming = async (ctx, { callClaude = callClaudeDefault, getDb = getBotDb, runTool = createToolRunner() } = {}) => {
  const db = await getDb();
  const key = { channel: ctx.channel, userId: ctx.userId };
  const convo = (await db.collection("conversations").findOne(key)) || {};

  if (convo.humanTakeover) {
    await db.collection("conversations").updateOne(key, {
      $push: { messages: { $each: [{ role: "user", content: ctx.text, at: new Date() }], $slice: -STORED_MESSAGES } },
    });
    return null;
  }

  const history = (convo.messages || []).slice(-HISTORY_TURNS).map(({ role, content }) => ({ role, content }));
  while (history.length && history[0].role !== "user") history.shift();

  const working = [...history, { role: "user", content: ctx.text }];
  let reply = "";

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await callClaude({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
      max_tokens: 900,
      system: buildSystemPrompt(ctx.channel),
      tools: toolsFor(ctx.channel),
      messages: working,
    });

    if (res.stop_reason === "tool_use") {
      working.push({ role: "assistant", content: res.content });
      const results = [];
      for (const block of res.content || []) {
        if (block.type !== "tool_use") continue;
        const out = await runTool(block.name, block.input || {}, ctx).catch((err) => {
          console.error(`[Tixy] herramienta ${block.name} falló:`, err.message);
          return { error: "No pude consultar ese dato ahora." };
        });
        results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out) });
      }
      working.push({ role: "user", content: results });
      continue;
    }

    reply = (res.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    break;
  }

  if (!reply) reply = FALLBACK_REPLY;

  await db.collection("conversations").updateOne(
    key,
    {
      $push: {
        messages: {
          $each: [
            { role: "user", content: ctx.text, at: new Date() },
            { role: "assistant", content: reply, at: new Date() },
          ],
          $slice: -STORED_MESSAGES,
        },
      },
      $set: { profileName: ctx.profileName || convo.profileName || "", updatedAt: new Date() },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  return reply;
};
