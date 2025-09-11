// workers/notifications.worker.js
import { startWorker } from "../lib/redisQueue.js";
import { runScheduledNotificationJob } from "../lib/notifications.js";

// Starts a BullMQ worker that processes scheduled notification steps
export function startNotificationsWorker() {
  const worker = startWorker(
    "notifications",
    async (job) => {
      const data = job.data || {};
      const { leadId, step } = data;
      if (!leadId || !step) {
        throw new Error("Invalid job data: missing leadId or step");
      }
      // Pass the entire job payload so new fields (overrides/vars) are supported
      await runScheduledNotificationJob(data);
    },
    { concurrency: 10 }
  );
  return worker;
}
