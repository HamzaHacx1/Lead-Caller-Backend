import { PrismaClient } from "@prisma/client";

// Reuse a single PrismaClient per process. In dev and prod, cache on globalThis
// to survive hot-reloads or module re-imports without spawning extra connections.
const g = globalThis;
const POOL_SIZE = Number(process.env.PRISMA_POOL_SIZE ?? "3");

const prisma =
  g.__prisma__ ||
  new PrismaClient({
    datasources: {
      db: { url: process.env.DATABASE_URL },
    },
    // Note: __internal options are not public API; prefer connection string
    // tuning in production. Kept here to retain existing behavior.
    __internal: {
      engine: {
        connectionPoolSize: POOL_SIZE,
        connectionTimeout: 5000,
        idleTimeout: 10000,
      },
    },
  });

// Cache the instance on global so repeated imports don't create new pools
g.__prisma__ = prisma;

export async function disconnectPrisma() {
  await prisma.$disconnect();
  console.log("Prisma connections closed");
}

export { prisma };
export default prisma;
