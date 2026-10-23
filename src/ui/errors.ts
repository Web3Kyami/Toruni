const hiddenTransportErrors = /^(?:failed to fetch|fetch failed|load failed|networkerror\b|network request failed|request timed out|timeout|timed out|aborted|aborterror\b|eai_again\b|enotfound\b|econn\w*\b|etimedout\b)/i;

export function userFacingError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  if (!message || error.name === "TypeError" || error.name === "TimeoutError" || error.name === "AbortError"
    || hiddenTransportErrors.test(message)) return fallback;
  return message;
}
