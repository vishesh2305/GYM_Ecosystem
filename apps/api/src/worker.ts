import { parseEnv } from "@gym/config";
import { apiEnvSchema } from "./env";
import { createWorker } from "./worker/create-worker";
import { handlers } from "./worker/handlers";

const worker = await createWorker(parseEnv(apiEnvSchema), { handlers });

const shutdown = () => {
  void worker.close().then(() => process.exit(0));
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
