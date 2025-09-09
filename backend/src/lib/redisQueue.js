// lib/redisQueue.js
// Centralized BullMQ connection + queue accessors
import { Queue, Worker, QueueEvents } from "bullmq";
import IORedis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

let connection;
let notificationQueue;
let notificationEvents;
let callQueue;
let callEvents;

export function getRedisConnection() {
  if (!connection) {
    // ioredis accepts a URL directly
    connection = new IORedis(REDIS_URL, {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
  }
  return connection;
}

export function getNotificationQueue() {
  if (!notificationQueue) {
    notificationQueue = new Queue("notifications", {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 50,
        removeOnFail: false,
      },
    });
  }
  return notificationQueue;
}

export function getNotificationEvents() {
  if (!notificationEvents) {
    notificationEvents = new QueueEvents("notifications", {
      connection: getRedisConnection(),
    });
  }
  return notificationEvents;
}

export function getCallQueue() {
  if (!callQueue) {
    // Enforce a global 3-minute gap by default using rate limiter
    const duration = Math.max(1, Number(process.env.CALL_GAP_MS ?? 180000));
    callQueue = new Queue("calls", {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 50,
        removeOnFail: false,
      },
      // Rate limiter is applied on the Worker, but Queue options kept standard
    });
  }
  return callQueue;
}

export function getCallEvents() {
  if (!callEvents) {
    callEvents = new QueueEvents("calls", { connection: getRedisConnection() });
  }
  return callEvents;
}

// Helper to start a worker with provided processor
export function startWorker(name, processor, opts = {}) {
  const worker = new Worker(name, processor, {
    connection: getRedisConnection(),
    concurrency: opts.concurrency ?? 5,
    limiter: opts.limiter,
  });
  worker.on("error", (err) => {
    console.error(`[queue:${name}] worker error`, err?.message);
  });
  return worker;
}
