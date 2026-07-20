import { randomBytes } from "crypto";

const SHARE_TOKEN_BYTES = 24;

export function createGuestPassShareToken(): string {
  return randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
}
