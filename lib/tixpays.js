// Consultas a la base de TixPays. SOLO LECTURA: únicamente find / aggregate / findOne.
// Nunca devuelve códigos de entradas ni datos de otras personas.
import { ObjectId } from "mongodb";
import { getTixpaysDb } from "./db.js";
import { formatDate, formatMoney, escapeRegex, phoneRegex, buildEventLink } from "./format.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const toObjectId = (id) => {
  try {
    return new ObjectId(String(id));
  } catch {
    return null;
  }
};

const orgsById = async (db, ids) => {
  const unique = [...new Set(ids.filter(Boolean).map(String))].map(toObjectId).filter(Boolean);
  if (!unique.length) return new Map();
  const orgs = await db
    .collection("organizations")
    .find({ _id: { $in: unique } }, { projection: { name: 1, slug: 1 } })
    .toArray();
  return new Map(orgs.map((o) => [String(o._id), o]));
};

/** Eventos publicados que todavía no pasaron (incluye los que empezaron hace menos de 6 h). */
export const searchEvents = async ({ texto } = {}, { getDb = getTixpaysDb, now = new Date() } = {}) => {
  const db = await getDb();
  const filter = { status: "published", date: { $gte: new Date(now.getTime() - 6 * HOUR) } };
  if (texto && String(texto).trim()) {
    const rx = new RegExp(escapeRegex(String(texto).trim()), "i");
    filter.$or = [{ name: rx }, { location: rx }];
  }
  const events = await db
    .collection("events")
    .find(filter, { projection: { name: 1, slug: 1, date: 1, location: 1, organization: 1 } })
    .sort({ date: 1 })
    .limit(10)
    .toArray();

  const orgs = await orgsById(db, events.map((e) => e.organization));
  return events.map((e) => {
    const org = orgs.get(String(e.organization));
    return {
      evento_id: String(e._id),
      nombre: e.name,
      productora: org?.name || "",
      fecha: formatDate(e.date),
      lugar: e.location,
      link: buildEventLink(e, org),
    };
  });
};

/** Detalle de un evento: entradas (precio, cargo, disponibilidad) y consumiciones a la venta. */
export const getEventDetails = async ({ evento_id } = {}, { getDb = getTixpaysDb } = {}) => {
  const id = toObjectId(evento_id);
  if (!id) return { error: "evento_id inválido" };
  const db = await getDb();

  const event = await db.collection("events").findOne(
    { _id: id, status: "published" },
    { projection: { name: 1, slug: 1, date: 1, location: 1, description: 1, mapsUrl: 1, organization: 1 } }
  );
  if (!event) return { error: "Evento no encontrado o no publicado" };

  const [orgs, ticketTypes, products] = await Promise.all([
    orgsById(db, [event.organization]),
    db.collection("ticket_types")
      .find({ event: id, status: "active" }, { projection: { name: 1, price: 1, serviceFee: 1, quota: 1, sold: 1 } })
      .sort({ price: 1 })
      .toArray(),
    db.collection("products")
      .find({ event: id, listed: true }, { projection: { name: 1, price: 1 } })
      .sort({ price: 1 })
      .limit(30)
      .toArray(),
  ]);
  const org = orgs.get(String(event.organization));

  return {
    nombre: event.name,
    productora: org?.name || "",
    fecha: formatDate(event.date),
    lugar: event.location,
    mapa: event.mapsUrl || "",
    descripcion: String(event.description || "").slice(0, 600),
    link: buildEventLink(event, org),
    entradas: ticketTypes.map((t) => {
      const disponibles = Math.max(Number(t.quota || 0) - Number(t.sold || 0), 0);
      return {
        tipo: t.name,
        precio: formatMoney(t.price),
        cargo_servicio: Number(t.serviceFee) > 0 ? formatMoney(t.serviceFee) : "sin cargo",
        estado: disponibles === 0 ? "AGOTADA" : disponibles <= 20 ? "últimas disponibles" : "disponible",
      };
    }),
    consumiciones: products.map((p) => ({ nombre: p.name, precio: formatMoney(p.price) })),
  };
};

/**
 * Compras del dueño del número de WhatsApp que escribe (últimos 120 días).
 * Solo se usa en WhatsApp: el número lo verifica WhatsApp, no lo escribe el usuario.
 */
export const getPurchasesByPhone = async (waNumber, { getDb = getTixpaysDb, now = new Date() } = {}) => {
  const rx = phoneRegex(waNumber);
  if (!rx) return { encontrado: false, motivo: "número inválido" };
  const db = await getDb();

  const users = await db
    .collection("users")
    .find({ phone: rx }, { projection: { _id: 1, first_name: 1 } })
    .limit(10)
    .toArray();
  if (!users.length) {
    return {
      encontrado: false,
      motivo: "No hay ninguna cuenta de TixPays con este número de WhatsApp. Puede haber comprado con otro número o sin cargar teléfono: pedile que revise el mail con el que compró (incluido spam) o derivá.",
    };
  }
  const buyerIds = users.map((u) => u._id);
  const since = new Date(now.getTime() - 120 * DAY);

  const [intents, consumptions] = await Promise.all([
    db.collection("payment_intents")
      .find(
        { buyer: { $in: buyerIds }, createdAt: { $gte: since }, status: { $in: ["approved", "pending", "rejected"] } },
        { projection: { event: 1, status: 1, items: 1, totalAmount: 1, consumptionsAmount: 1, passes: 1, buyerEmail: 1, createdAt: 1, whatsappSentAt: 1 } }
      )
      .sort({ createdAt: -1 })
      .limit(8)
      .toArray(),
    db.collection("consumption_orders")
      .find(
        { buyer: { $in: buyerIds }, createdAt: { $gte: since }, status: "approved" },
        { projection: { event: 1, codes: 1, totalAmount: 1, createdAt: 1 } }
      )
      .sort({ createdAt: -1 })
      .limit(8)
      .toArray(),
  ]);

  const eventIds = [...intents, ...consumptions].map((x) => x.event).filter(Boolean);
  const events = eventIds.length
    ? await db.collection("events").find({ _id: { $in: eventIds } }, { projection: { name: 1, date: 1 } }).toArray()
    : [];
  const eventMap = new Map(events.map((e) => [String(e._id), e]));

  const maskEmail = (email) => {
    const [user, domain] = String(email || "").split("@");
    if (!user || !domain) return "";
    return `${user.slice(0, 2)}•••@${domain}`;
  };

  const ESTADO = { approved: "aprobada", pending: "pago pendiente", rejected: "pago rechazado" };

  return {
    encontrado: true,
    nombre: users[0].first_name || "",
    compras_entradas: intents.map((i) => {
      const ev = eventMap.get(String(i.event));
      return {
        evento: ev?.name || "",
        fecha_evento: formatDate(ev?.date),
        fecha_compra: formatDate(i.createdAt),
        estado: ESTADO[i.status] || i.status,
        detalle: (i.items || []).map((it) => `${it.quantity} x ${it.name}`).join(", "),
        total: formatMoney(Number(i.totalAmount || 0) + Number(i.consumptionsAmount || 0)),
        entradas_emitidas: (i.passes || []).length,
        enviadas_a: i.status === "approved" ? maskEmail(i.buyerEmail) : "",
        enviadas_por_whatsapp: Boolean(i.whatsappSentAt),
      };
    }),
    compras_consumiciones: consumptions.map((c) => {
      const ev = eventMap.get(String(c.event));
      const codes = c.codes || [];
      return {
        evento: ev?.name || "",
        fecha_compra: formatDate(c.createdAt),
        total: formatMoney(c.totalAmount),
        codigos: codes.length,
        canjeados: codes.filter((x) => x.status === "redeemed").length,
      };
    }),
  };
};
