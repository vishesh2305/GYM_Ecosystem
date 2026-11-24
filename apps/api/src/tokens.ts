// Injection tokens. Every constructor dependency uses @Inject(token) explicitly (see ADR 007).
export const ENV = Symbol("ENV");
export const DB = Symbol("DB");
export const REDIS = Symbol("REDIS");
