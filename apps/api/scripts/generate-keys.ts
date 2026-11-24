// Prints fresh secrets for .env:  pnpm --filter @gym/api keys >> ../../.env
import { generateKeyPairSync } from "node:crypto";

const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
process.stdout.write(`JWT_PRIVATE_JWK='${JSON.stringify(jwk)}'\n`);
