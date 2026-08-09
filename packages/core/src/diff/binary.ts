/**
 * Binary-content detection for diff/merge: a NUL byte within the first 8KB
 * means binary (matching the Canonical Hash Algorithm's text detection in
 * `integrity/canonical-hash.ts`).
 */

const TEXT_SAMPLE_BYTES = 8192

/** True when the byte content is binary (NUL byte in the first 8KB). */
export function isBinaryContent(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, TEXT_SAMPLE_BYTES)
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) {
      return true
    }
  }
  return false
}
