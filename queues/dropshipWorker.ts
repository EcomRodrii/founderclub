import { Worker } from "bullmq";
import { redisConnection } from "./redis.js";
import { pool } from "../db.js";
import { addTemuToCart } from "../temu-cart.js";
import crypto from "crypto";

const CTRL_KEY = (process.env.CONTROL_ENCRYPTION_KEY || "").slice(0, 32);

function ctrlDecrypt(text: string): string {
  if (!text) return text;
  if (text.startsWith("gcm:")) {
    const parts = text.split(":");
    if (parts.length < 4) return "";
    try {
      const iv      = Buffer.from(parts[1], "hex");
      const authTag = Buffer.from(parts[2], "hex");
      const enc     = parts[3];
      const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(CTRL_KEY), iv);
      (decipher as any).setAuthTag(authTag);
      let dec = decipher.update(enc, "hex", "utf8");
      dec += decipher.final("utf8");
      return dec;
    } catch { return ""; }
  }
  return "";
}

export function startDropshipWorker() {
  if (!redisConnection) {
    console.warn("[dropship] Redis no disponible — worker desactivado");
    return;
  }

  const worker = new Worker(
    "dropship",
    async (job) => {
      const { type, userId, orderId } = job.data;

      if (type === "buy_temu") {
        if (!orderId) throw new Error("orderId requerido para buy_temu");

        // Load order + product + temu credentials
        const orderRes = await pool.query(
          `SELECT o.*, p.temu_url, p.title as product_title,
                  tc.cookies_enc, tc.email as temu_email
           FROM dropship_orders o
           LEFT JOIN dropship_products p ON p.id = o.product_id
           LEFT JOIN temu_credentials tc ON tc.user_id = o.user_id
           WHERE o.id = $1 AND o.user_id = $2`,
          [orderId, userId]
        );
        if (!orderRes.rows[0]) throw new Error("Pedido no encontrado");
        const order = orderRes.rows[0];

        if (!order.temu_url) throw new Error("Este pedido no tiene URL de Temu asociada");

        const cookiesJson = order.cookies_enc ? ctrlDecrypt(order.cookies_enc) : "";
        const address = order.buyer_address_enc ? ctrlDecrypt(order.buyer_address_enc) : "";

        const result = await addTemuToCart({
          productUrl: order.temu_url,
          deliveryName: order.buyer_name || "",
          deliveryAddress: address,
          cookiesJson,
        });

        if (!result.success) throw new Error(result.error || "Error en Temu");

        await pool.query(
          `UPDATE dropship_orders
           SET status = 'purchased_temu', temu_cart_screenshot = $1, updated_at = NOW()
           WHERE id = $2`,
          [result.screenshot || null, orderId]
        );
        return { screenshot: result.screenshot };
      }

      throw new Error(`Tipo de job desconocido: ${type}`);
    },
    {
      connection: redisConnection,
      concurrency: 1,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[dropship worker] Job ${job?.id} failed:`, err.message);
  });

  console.log("[dropship] Worker iniciado ✓");
}
