// Dos conexiones separadas:
//  - TixPays (SOLO LECTURA): la base de producción. El usuario de Atlas tiene rol "read",
//    así que cualquier escritura la rechaza MongoDB aunque el código lo intentara.
//  - Bot: base propia (tixy_bot) para conversaciones, leads y deduplicación.
import { MongoClient } from "mongodb";

const cache = globalThis.__tixyMongo || (globalThis.__tixyMongo = {});

const connect = (key, uri) => {
  if (!uri) throw new Error(`Falta la variable de conexión para ${key}`);
  if (!cache[key]) {
    cache[key] = new MongoClient(uri, { maxPoolSize: 5, readPreference: "secondaryPreferred" })
      .connect()
      .catch((err) => {
        delete cache[key];
        throw err;
      });
  }
  return cache[key];
};

export const getTixpaysDb = async () => {
  const client = await connect("tixpays", process.env.TIXPAYS_MONGODB_URI);
  return client.db(process.env.TIXPAYS_DB || undefined);
};

let botIndexesReady = false;

export const getBotDb = async () => {
  const client = await connect("bot", process.env.BOT_MONGODB_URI);
  const db = client.db(process.env.BOT_DB || "tixy_bot");
  if (!botIndexesReady) {
    await Promise.all([
      db.collection("processed").createIndex({ mid: 1 }, { unique: true }),
      db.collection("processed").createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 }),
      db.collection("conversations").createIndex({ channel: 1, userId: 1 }, { unique: true }),
      db.collection("leads").createIndex({ channel: 1, userId: 1 }, { unique: true }),
    ]);
    botIndexesReady = true;
  }
  return db;
};

// Devuelve true si el id es nuevo (Meta reintenta webhooks).
export const claimEvent = async (mid) => {
  const db = await getBotDb();
  try {
    await db.collection("processed").insertOne({ mid, createdAt: new Date() });
    return true;
  } catch (err) {
    if (err.code === 11000) return false;
    throw err;
  }
};
