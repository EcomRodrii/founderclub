import { Queue } from "bullmq";
import { redisConnection } from "./redis.js";

export type DropshipJobType = "scan_vinted_sales" | "buy_temu";

export interface DropshipJobData {
  type: DropshipJobType;
  userId: number;
  accountId?: number; // vinted_account id for scan_vinted_sales
  orderId?: number;   // dropship_orders id for buy_temu
}

export const dropshipQueue = redisConnection
  ? new Queue<DropshipJobData>("dropship", {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: "exponential", delay: 10_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
      },
    })
  : null;
