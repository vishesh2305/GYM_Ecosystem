// Writes apps/api/openapi.json. CI fails if it differs from the committed file, and checks PRs for breaking changes.
import { writeFileSync } from "node:fs";
import { buildApiDocs } from "../src/docs";

writeFileSync(
  new URL("../openapi.json", import.meta.url),
  `${JSON.stringify(buildApiDocs(), null, 2)}\n`,
);
