import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import { ObjectId } from "mongodb";
import { isValidSignature, extractEvents } from "./meta.js";
import { phoneRegex, formatMoney, formatDate, buildEventLink, splitText } from "./format.js";
import { calcularNivel, handleIncoming, createToolRunner, toolsFor, FALLBACK_REPLY } from "./agent.js";
import { searchEvents, getEventDetails, getPurchasesByPhone } from "./tixpays.js";

// ---------- DB falsa (solo lectura para TixPays, registra escrituras del bot) ----------
const matches = (doc, filter) =>
  Object.entries(filter).every(([k, cond]) => {
    if (k === "$or") return cond.some((f) => matches(doc, f));
    const v = doc[k];
    if (cond instanceof RegExp) return cond.test(String(v ?? ""));
    if (cond && typeof cond === "object" && !(cond instanceof ObjectId) && !(cond instanceof Date)) {
      return Object.entries(cond).every(([op, x]) => {
        if (op === "$in") return x.some((y) => String(y) === String(v));
        if (op === "$gte") return v >= x;
        return true;
      });
    }
    return String(v) === String(cond);
  });

const fakeDb = (data) => {
  const writes = [];
  return {
    writes,
    collection: (name) => ({
      find: (filter = {}) => {
        let rows = (data[name] || []).filter((d) => matches(d, filter));
        const cursor = {
          sort: () => cursor,
          limit: (n) => { rows = rows.slice(0, n); return cursor; },
          toArray: async () => rows,
        };
        return cursor;
      },
      findOne: async (filter = {}) => (data[name] || []).find((d) => matches(d, filter)) || null,
      updateOne: async (...args) => { writes.push([name, ...args]); },
      insertOne: async (...args) => { writes.push([name, "insert", ...args]); },
    }),
  };
};

const ORG = { _id: new ObjectId(), name: "Sur Producciones", slug: "sur" };
const EV = { _id: new ObjectId(), name: "Noche Electrónica", slug: "noche", status: "published", date: new Date("2026-11-07T02:00:00Z"), location: "Club Central", organization: ORG._id };
const USER = { _id: new ObjectId(), first_name: "Sofi", phone: "+54 3827 43-8139" };

const DATA = {
  organizations: [ORG],
  events: [EV, { ...EV, _id: new ObjectId(), name: "Borrador", status: "draft" }],
  ticket_types: [
    { _id: new ObjectId(), event: EV._id, status: "active", name: "General", price: 15000, serviceFee: 1500, quota: 100, sold: 100 },
    { _id: new ObjectId(), event: EV._id, status: "active", name: "VIP", price: 30000, serviceFee: 0, quota: 50, sold: 40 },
  ],
  products: [{ _id: new ObjectId(), event: EV._id, listed: true, name: "Combo Fernet", price: 9000 }],
  users: [USER],
  payment_intents: [{
    _id: new ObjectId(), buyer: USER._id, event: EV._id, status: "approved", createdAt: new Date("2026-10-20T15:00:00Z"),
    items: [{ name: "General", quantity: 2 }], totalAmount: 33000, consumptionsAmount: 0, passes: [new ObjectId(), new ObjectId()],
    buyerEmail: "sofia@gmail.com",
  }],
  consumption_orders: [],
};
const NOW = new Date("2026-10-29T12:00:00Z");

// ---------- Tests ----------
test("firma de Meta: válida con cualquiera de los secrets, inválida si no", () => {
  const body = Buffer.from('{"object":"instagram"}');
  const sig = (s) => "sha256=" + crypto.createHmac("sha256", s).update(body).digest("hex");
  assert.equal(isValidSignature(body, sig("a"), ["a", "b"]), true);
  assert.equal(isValidSignature(body, sig("b"), ["a", "b"]), true);
  assert.equal(isValidSignature(body, sig("c"), ["a", "b"]), false);
  assert.equal(isValidSignature(body, undefined, ["a"]), false);
  assert.equal(isValidSignature(body, sig("a"), []), false);
});

test("extractEvents: WhatsApp e Instagram (sin ecos, comentarios con palabra clave)", () => {
  const wa = extractEvents({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { metadata: { phone_number_id: "PN" }, contacts: [{ profile: { name: "Sofi" } }], messages: [
      { id: "w1", from: "5493827438139", type: "text", text: { body: "hola" } },
      { id: "w2", from: "5493827438139", type: "audio" },
    ] } }] }],
  }, []);
  assert.deepEqual(wa.map((e) => [e.mid, e.text, e.unsupported]), [["w1", "hola", false], ["w2", null, true]]);

  const ig = extractEvents({
    object: "instagram",
    entry: [{ id: "OWN", messaging: [
      { sender: { id: "U1" }, message: { mid: "m1", text: "info" } },
      { sender: { id: "OWN" }, message: { mid: "m2", text: "eco", is_echo: true } },
    ], changes: [
      { field: "comments", value: { id: "c1", text: "quiero entradas", from: { id: "U3" } } },
      { field: "comments", value: { id: "c2", text: "lindo", from: { id: "U4" } } },
    ] }],
  }, ["ENTRADA"]);
  assert.deepEqual(ig.map((e) => [e.kind, e.mid]), [["message", "m1"], ["comment", "comment_c1"]]);
});

test("formato: teléfono, plata, fecha, link, cortes", () => {
  const rx = phoneRegex("5493827438139");
  assert.ok(rx.test("+54 3827 43-8139"));
  assert.ok(rx.test("3827438139"));
  assert.ok(!rx.test("+54 3827 43-8130"));
  assert.equal(phoneRegex("123"), null);
  assert.equal(formatMoney(15000), "$15.000");
  assert.match(formatDate("2026-11-07T02:00:00Z"), /6\/11.*23:00/);
  process.env.FRONT_URL = "https://tixpays.com/";
  assert.equal(buildEventLink(EV, ORG), "https://tixpays.com/eventos/sur/noche");
  const parts = splitText("a ".repeat(100), 30);
  assert.ok(parts.every((p) => p.length <= 30));
});

test("calcularNivel", () => {
  assert.equal(calcularNivel({ asistentes: 2000 }), "A");
  assert.equal(calcularNivel({ tipoEvento: "festival" }), "A");
  assert.equal(calcularNivel({ asistentes: 500, recurrente: true }), "B");
  assert.equal(calcularNivel({ asistentes: 500 }), "C");
  assert.equal(calcularNivel({}), null);
});

test("searchEvents: solo publicados y futuros, con link", async () => {
  const db = fakeDb(DATA);
  const r = await searchEvents({}, { getDb: async () => db, now: NOW });
  assert.equal(r.length, 1);
  assert.equal(r[0].nombre, "Noche Electrónica");
  assert.equal(r[0].productora, "Sur Producciones");
  assert.equal(r[0].link, "https://tixpays.com/eventos/sur/noche");
  assert.equal(db.writes.length, 0);
});

test("getEventDetails: precios, cargo y agotadas", async () => {
  const db = fakeDb(DATA);
  const r = await getEventDetails({ evento_id: String(EV._id) }, { getDb: async () => db });
  assert.deepEqual(r.entradas.map((e) => [e.tipo, e.precio, e.cargo_servicio, e.estado]), [
    ["General", "$15.000", "$1.500", "AGOTADA"],
    ["VIP", "$30.000", "sin cargo", "últimas disponibles"],
  ]);
  assert.deepEqual(r.consumiciones, [{ nombre: "Combo Fernet", precio: "$9.000" }]);
  assert.equal((await getEventDetails({ evento_id: "x" }, { getDb: async () => db })).error, "evento_id inválido");
});

test("getPurchasesByPhone: encuentra por número, enmascara mail, sin códigos", async () => {
  const db = fakeDb(DATA);
  const r = await getPurchasesByPhone("5493827438139", { getDb: async () => db, now: NOW });
  assert.equal(r.encontrado, true);
  const c = r.compras_entradas[0];
  assert.equal(c.estado, "aprobada");
  assert.equal(c.detalle, "2 x General");
  assert.equal(c.entradas_emitidas, 2);
  assert.equal(c.enviadas_a, "so•••@gmail.com");
  assert.ok(!JSON.stringify(r).includes("sofia@"));
  const none = await getPurchasesByPhone("5491100000000", { getDb: async () => db, now: NOW });
  assert.equal(none.encontrado, false);
});

test("mis_compras solo existe en WhatsApp", async () => {
  assert.ok(toolsFor("whatsapp").some((t) => t.name === "mis_compras"));
  assert.ok(!toolsFor("instagram").some((t) => t.name === "mis_compras"));
  const run = createToolRunner({ tixpays: { getPurchasesByPhone: async () => ({ ok: true }) } });
  assert.deepEqual(await run("mis_compras", {}, { channel: "instagram", userId: "U1" }), { error: "Solo disponible por WhatsApp" });
});

test("handleIncoming: usa herramientas y guarda la conversación en la base del bot", async () => {
  const botDb = fakeDb({});
  const calls = [];
  const callClaude = async (body) => {
    calls.push(body);
    if (calls.length === 1) return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name: "buscar_eventos", input: {} }] };
    return { stop_reason: "end_turn", content: [{ type: "text", text: "Tenemos Noche Electrónica el viernes 🎉" }] };
  };
  const runTool = async (name) => ({ eventos: [{ nombre: "Noche Electrónica" }], tool: name });
  const reply = await handleIncoming(
    { channel: "whatsapp", userId: "5493827438139", text: "¿qué eventos hay?" },
    { callClaude, getDb: async () => botDb, runTool }
  );
  assert.equal(reply, "Tenemos Noche Electrónica el viernes 🎉");
  assert.equal(JSON.parse(calls[1].messages.at(-1).content[0].content).tool, "buscar_eventos");
  const saved = botDb.writes.at(-1);
  assert.equal(saved[0], "conversations");
  assert.deepEqual(saved[2].$push.messages.$each.map((m) => m.role), ["user", "assistant"]);
});

test("handleIncoming: derivada no responde; sin texto usa respaldo", async () => {
  const derived = fakeDb({ conversations: [{ channel: "instagram", userId: "U1", humanTakeover: true }] });
  assert.equal(await handleIncoming({ channel: "instagram", userId: "U1", text: "hola" }, { getDb: async () => derived, callClaude: async () => { throw new Error("no"); } }), null);
  const empty = fakeDb({});
  assert.equal(await handleIncoming({ channel: "instagram", userId: "U2", text: "hola" }, { getDb: async () => empty, callClaude: async () => ({ stop_reason: "end_turn", content: [] }) }), FALLBACK_REPLY);
});
