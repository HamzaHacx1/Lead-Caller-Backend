// workers/notifications.worker.js
import { startWorker } from "../lib/redisQueue.js";
import { runScheduledNotificationJob } from "../lib/notifications.js";

// Starts a BullMQ worker that processes scheduled notification steps
export function startNotificationsWorker() {
  const worker = startWorker(
    "notifications",
    async (job) => {
      const { leadId, step, attemptNumber = 1, eventId = null } = job.data || {};
      if (!leadId || !step) {
        throw new Error("Invalid job data: missing leadId or step");
      }
      await runScheduledNotificationJob({ leadId, step, attemptNumber, eventId });
    },
    { concurrency: 10 }
  );
  return worker;
}

