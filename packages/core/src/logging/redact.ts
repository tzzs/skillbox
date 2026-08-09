/**
 * Log redaction (SPEC §76 / SPEC §125.1).
 *
 * Skillbox must never write secrets to logs. Redaction is defensive: even if a
 * caller passes a context object that happens to contain one of the well-known
 * secret fields, its value is masked before the line is emitted. The redaction
 * is key-name based (case-insensitive substring match) so nested fields such as
 * `accessToken`, `client_secret` or `sharedSecret` are caught too.
 */

/** Well-known secret-ish keys whose values are always masked. */
export const SENSITIVE_KEY_PATTERN =
  /(token|secret|password|passwd|credential|api[_-]?key|api_?key|authorization)/i

export const REDACTED = '[REDACTED]'

/** True when `key` should never leak its value into a log line. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key)
}

/**
 * JSON-serializes `value` while masking any field whose key matches the
 * sensitive-key pattern. Uses `JSON.stringify`'s replacer so redaction applies
 * at any nesting depth. Returns "[REDACTED]" when the value cannot be
 * serialized (e.g. circular references).
 */
export function safeSerialize(value: unknown): string {
  try {
    return (
      JSON.stringify(value, (_key, val) => (isSensitiveKey(_key) ? REDACTED : val)) ?? String(value)
    )
  } catch {
    return REDACTED
  }
}

/**
 * Masks token-like snippets that appear directly inside a free-form message,
 * e.g. `"token=abc123"` or `"Authorization: Bearer xyz=="`. Key-name based
 * masking handles the structured case; this catches values smuggled into text.
 */
export function scrubText(input: string): string {
  let scrubbed = input.replace(/\b(Bearer)\s+[A-Za-z0-9._~+/-]+/gi, '$1 ' + REDACTED)
  scrubbed = scrubbed.replace(
    /\b([A-Za-z0-9_]*(?:token|secret|password|passwd|credential|api[_-]?key)[A-Za-z0-9_]*)\s*=\s*[^\s"'&,;`]+/gi,
    `$1=${REDACTED}`,
  )
  return scrubbed
}
