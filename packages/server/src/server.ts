import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { openExecutionStore } from "./config.js";

const { store, filename } = openExecutionStore();
const port = Number(process.env.MTA_PORT ?? 3210);
const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const app = await buildApp({
  store,
  worker: {
    async runOnce() { return false; },
    recoverExpired() { return 0; },
    requestCancel(taskId) {
      const task = store.getTask(taskId);
      return task
        ? { affected: store.requestCancelChain(task.chainId), attemptId: task.activeAttemptId }
        : { affected: 0, attemptId: null };
    },
  },
  staticRoot: resolve(root, "packages/web/dist"),
});
await app.listen({ host: "127.0.0.1", port });
console.log(`my-team-agents P7a development server: http://127.0.0.1:${port}`);
console.log(`SQLite: ${filename}`);
console.log("Development mode: no login or tenant isolation; loopback only.");

const shutdown = async () => { await app.close(); store.close(); };
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
