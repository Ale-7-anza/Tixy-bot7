// Utilidades puras (sin red ni base): formato de fechas, precios, teléfonos y links.

const TZ = "America/Argentina/Buenos_Aires";

export const formatDate = (date) => {
  if (!date) return "";
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "";
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("es-AR", {
      timeZone: TZ,
      weekday: "short",
      day: "numeric",
      month: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value])
  );
  const weekday = String(parts.weekday || "").replace(/\.$/, "");
  return `${weekday} ${parts.day}/${parts.month} ${parts.hour}:${parts.minute}`; // "vie 6/11 23:00"
};

export const formatMoney = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return "$" + new Intl.NumberFormat("es-AR", { maximumFractionDigits: 2 }).format(n);
};

export const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// WhatsApp manda "5493764123456". En la base el teléfono puede estar como "+54 3764 123456",
// "3764-123456", etc. Se compara por los últimos 10 dígitos, ignorando separadores.
export const phoneRegex = (waNumber) => {
  const digits = String(waNumber || "").replace(/\D/g, "");
  if (digits.length < 10) return null;
  const last10 = digits.slice(-10);
  return new RegExp(last10.split("").join("\\D*") + "\\D*$");
};

const slugify = (value = "") =>
  String(value).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

// EVENT_URL_TEMPLATE admite {org} y {event}. Default: FRONT_URL/eventos/{org}/{event}
export const buildEventLink = (event, org) => {
  const base = (process.env.FRONT_URL || "https://tixpays.com").trim().replace(/\/+$/, "");
  const orgSlug = org?.slug || slugify(org?.name || "");
  const eventSlug = event?.slug || slugify(event?.name || "");
  if (!orgSlug || !eventSlug) return base;
  const path = (process.env.EVENT_URL_TEMPLATE || "/eventos/{org}/{event}")
    .replace("{org}", encodeURIComponent(orgSlug))
    .replace("{event}", encodeURIComponent(eventSlug));
  return `${base}${path}`;
};

// Corta textos largos priorizando saltos de línea y espacios.
export const splitText = (text, size) => {
  const parts = [];
  let rest = String(text || "").trim();
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = rest.lastIndexOf(" ", size);
    if (cut <= 0) cut = size;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
};
