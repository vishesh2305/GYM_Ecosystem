import { health, ready } from "./system";

/** Every API operation. The key is the OpenAPI operationId. */
export const routes = { health, ready };
