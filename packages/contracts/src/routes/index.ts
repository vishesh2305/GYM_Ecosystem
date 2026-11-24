import {
  listSessions,
  refreshSession,
  requestOtp,
  revokeSession,
  signOut,
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
  refreshSession,
  signOut,
  signOutEverywhere,
  listSessions,
  revokeSession,
  getMe,
  updateMe,
};
