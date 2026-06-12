import IORedis from "ioredis";

const url = process.env.REDIS_URL;
if (!url) console.warn("[redis] REDIS_URL no configurada — BullMQ desactivado (modo síncrono)");

// Cast to any: BullMQ bundles its own ioredis, causing a version type mismatch at compile time.
// At runtime they are compatible — same duck-typed interface.
export const redisConnection: any = url
  ? new IORedis(url, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    })
  : null;
