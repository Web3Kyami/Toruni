import { createHash } from "node:crypto";
/** Stable public alias without publishing the Strike account identifier. */
export function publicMakerId(accountId: string): string {
  return createHash("sha256").update(`toruni-maker-v1:${accountId}`).digest("hex").slice(0,12);
}
