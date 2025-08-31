import { processScheduledNotifications } from "./lib/notifications";

processScheduledNotifications().then(() => process.exit());
