import { Queue } from "bullmq";
import { redisConnection } from "./redis.js";

export interface LenguetaJobData {
  userId: number;
  licenseId: number;
  brand: string;
  detections: Record<string, unknown>;
  customPrompt: string;
  imageBase64: string;
}

export interface LenguetaJobResult {
  image: string;
  model: string;
}

export const lenguetaQueue = redisConnection
  ? new Queue<LenguetaJobData, LenguetaJobResult>("lengueta", {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5_000 },
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 100 },
      },
    })
  : null;
