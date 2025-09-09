import dotenv from "dotenv";

dotenv.config();
// Ensure a tiny pool for this worker before loading Prisma-dependent modules
process.env.PRISMA_POOL_SIZE = process.env.PRISMA_POOL_SIZE || "1";

const { processScheduledNotifications } = await import("./lib/notifications.js");
const { default: prisma, disconnectPrisma } = await import("./lib/prisma.js");

const INTERVAL_MS = 30_000; // 30 seconds
const NOTIFY_QUEUE_ENABLED = (process.env.NOTIFY_QUEUE_ENABLED ?? "1") === "1";

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tick() {
  try {
    // Process fewer notifications to reduce load
    await processScheduledNotifications(50); // Reduced from 200
  } catch (e) {
    console.warn("[cron] process error:", e?.message);
  }
}

async function main() {
  if (NOTIFY_QUEUE_ENABLED) {
    console.log("[cron] BullMQ notifications enabled; cron worker is idle.");
    return; // do nothing when queue-based scheduling is enabled
  }
  console.log("[cron] notifications worker started; interval =", INTERVAL_MS, "ms");
  const stop = async () => {
    await disconnectPrisma();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (true) {
    await tick();
    await sleep(INTERVAL_MS);
  }
}

main();
