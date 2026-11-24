import { buildOpenApi, routes } from "@gym/contracts";

export const buildApiDocs = () =>
  buildOpenApi(routes, { title: "Gym Platform API", version: "1.0.0" });
