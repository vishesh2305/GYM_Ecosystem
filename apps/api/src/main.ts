import { parseEnv } from "@gym/config";
import { createApp } from "./app";
import { apiEnvSchema } from "./env";

const env = parseEnv(apiEnvSchema);
const { app } = await createApp(env);
app.enableShutdownHooks();
await app.listen({ port: env.PORT, host: env.HOST });
