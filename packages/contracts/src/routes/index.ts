import {
  confirmTotp,
  disableTotp,
  getMfaStatus,
  listSessions,
  setupTotp,
  verifyMfa,
  refreshSession,
  requestOtp,
  revokeSession,
  signOut,
  signInWithProvider,
  signOutEverywhere,
  verifyOtp,
} from "./auth";
import { getMe, updateMe } from "./me";
import { health, ready } from "./system";

/** Every API operation. The key is the OpenAPI operationId. */
export const routes = {
  health,
  ready,
  requestOtp,
  verifyOtp,
  signInWithProvider,
  refreshSession,
  signOut,
  signOutEverywhere,
  listSessions,
  revokeSession,
  getMfaStatus,
  setupTotp,
  confirmTotp,
  verifyMfa,
  disableTotp,
  getMe,
  updateMe,
};
