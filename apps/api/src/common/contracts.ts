import { routes } from "@gym/contracts";

/** Route contracts typed as non-optional parts, for use in ZodPipe(...) inside controllers. */
export const contracts = routes as {
  [K in keyof typeof routes]: Required<(typeof routes)[K]>;
};
