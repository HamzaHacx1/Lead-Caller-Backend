// src/cron.js  (or wherever yours lives)
import dotenv from "dotenv";

dotenv.config();
import prisma from "./lib/prisma";
import { processScheduledNotifications } from "./lib/notifications.js"; // note the .js

// note the .js

const INTERVAL_MS = 30_000; // run every 30s

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tick() {
  try {
    await processScheduledNotifications(200); // pick up due events
  } catch (e) {
    console.warn("[cron] process error:", e?.message);
  }
}

async function main() {
  console.log(
    "[cron] notifications worker started; interval =",
    INTERVAL_MS,
    "ms"
  );
  // graceful shutdown
  const stop = async () => {
    await prisma.$disconnect();
    console.log("Prisma connections closed");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // forever loop
  while (true) {
    await tick();
    await sleep(INTERVAL_MS);
  }
}

main();
