// Injection tokens. Every constructor dependency uses @Inject(token) explicitly (see ADR 007).
export const ENV = Symbol("ENV");
export const DB = Symbol("DB");
export const REDIS = Symbol("REDIS");
export const SMS_SENDER = Symbol("SMS_SENDER");
export const EMAIL_SENDER = Symbol("EMAIL_SENDER");
export const PAYMENT_GATEWAY = Symbol("PAYMENT_GATEWAY");
