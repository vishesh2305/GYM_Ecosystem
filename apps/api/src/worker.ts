import { parseEnv } from "@gym/config";
import { apiEnvSchema } from "./env";
import { createWorker } from "./worker/create-worker";

const worker = await createWorker(parseEnv(apiEnvSchema));

const shutdown = () => {
  void worker.close().then(() => process.exit(0));
};
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
