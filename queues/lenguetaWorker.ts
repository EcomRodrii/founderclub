import { Worker } from "bullmq";
import { redisConnection } from "./redis.js";
import { pool } from "../db.js";
import { buildTonguePrompt, jpegDimsFromBase64, pickGeminiAspect } from "../geminiUtils.js";
import type { LenguetaJobData, LenguetaJobResult } from "./lenguetaQueue.js";

const IMG_MODELS = [
  "gemini-3.1-flash-image",
  "gemini-2.5-flash-image",
  "gemini-3-pro-image",
  "gemini-2.0-flash-preview-image-generation",
];
const GLOBAL_TIMEOUT_MS = 140_000;
const ATTEMPT_TIMEOUT_MS = 45_000;

async function processLenguetaJob(data: LenguetaJobData): Promise<LenguetaJobResult> {
  const { userId, licenseId, brand, detections, customPrompt, imageBase64 } = data;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY no configurada");

  const prompt = buildTonguePrompt(brand, detections, customPrompt || "", false);

  let aspectRatio: string | null = null;
  if (imageBase64) {
    const b64 = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
    const dims = jpegDimsFromBase64(b64);
    if (dims && dims.w > 0 && dims.h > 0) aspectRatio = pickGeminiAspect(dims.w, dims.h);
  }

  const parts: any[] = [];
  if (imageBase64) {
    const b64 = imageBase64.includes(",") ? imageBase64.split(",")[1] : imageBase64;
    parts.push({ inlineData: { mimeType: "image/jpeg", data: b64 } });
  }
  parts.push({ text: prompt });

  const deadline = Date.now() + GLOBAL_TIMEOUT_MS;
  let lastErr = "";

  for (const model of IMG_MODELS) {
    if (Date.now() >= deadline) break;

    const body: any = {
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        temperature: 0.35,
      },
    };
    if (aspectRatio) body.generationConfig.imageConfig = { aspectRatio };

    try {
      const ctrl = new AbortController();
      const msLeft = Math.max(5_000, deadline - Date.now());
      const timer = setTimeout(() => ctrl.abort(), Math.min(ATTEMPT_TIMEOUT_MS, msLeft));
      let r: any, resData: any;
      try {
        r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal }
        );
        resData = await r.json();
      } finally { clearTimeout(timer); }

      if (!r.ok) {
        lastErr = resData?.error?.message || `HTTP ${r.status}`;
        console.error(`[lengueta-worker] ${model} HTTP ${r.status}:`, lastErr.slice(0, 120));
        if (r.status === 429) await new Promise(resolve => setTimeout(resolve, 4_000));
        continue;
      }

      for (const p of (resData.candidates?.[0]?.content?.parts || [])) {
        if (p.inlineData?.data) {
          await pool.query(
            "UPDATE licenses SET image_tokens = image_tokens - 1 WHERE id = $1 AND image_tokens IS NOT NULL",
            [licenseId]
          );
          console.log(`[lengueta-worker] job completado — user ${userId}, model ${model}`);
          return { image: `data:image/png;base64,${p.inlineData.data}`, model };
        }
      }
      lastErr = "Sin imagen en respuesta";
    } catch (err: any) {
      lastErr = err.message || String(err);
      console.error(`[lengueta-worker] ${model} error:`, lastErr.slice(0, 120));
    }
  }

  throw new Error(lastErr || "Ningún modelo devolvió imagen");
}

export function startLenguetaWorker() {
  if (!redisConnection) {
    console.log("[lengueta-worker] Redis no configurado — worker no iniciado");
    return null;
  }

  const worker = new Worker<LenguetaJobData, LenguetaJobResult>(
    "lengueta",
    (job) => processLenguetaJob(job.data),
    {
      connection: redisConnection,
      concurrency: 3,
    }
  );

  worker.on("failed", (job, err) => {
    console.error(`[lengueta-worker] job ${job?.id} fallido (${job?.data?.brand}):`, err.message);
  });

  console.log("[lengueta-worker] iniciado (concurrencia: 3)");
  return worker;
}
