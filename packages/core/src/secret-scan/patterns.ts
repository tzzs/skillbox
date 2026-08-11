export type SecretSeverity = 'critical' | 'high' | 'medium' | 'low'

export type FindingScope = 'file' | 'content'

/** Lower rank means more severe; used to partition results. */
export const SEVERITY_RANK: Record<SecretSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
}

export function isBlockingSeverity(severity: SecretSeverity): boolean {
  return severity === 'critical' || severity === 'high'
}

export interface SecretPatternBase {
  id: string
  name: string
  severity: SecretSeverity
  findingScope: FindingScope
  description: string
  recommendation: string
}

export interface ContentSecretPattern extends SecretPatternBase {
  /** Case-insensitive regex, matched once per line (no `/g` flag). */
  regex: RegExp
  findingScope: 'content'
}

export interface FileSecretPattern extends SecretPatternBase {
  /** Basename globs (gitignore-style, no `/`), matched case-insensitively. */
  globs: readonly string[]
  findingScope: 'file'
}

const CRITICAL = 'critical' as const
const HIGH = 'high' as const
const MEDIUM = 'medium' as const
const LOW = 'low' as const

const CREDENTIAL_FILE_RECOMMENDATION =
  'Remove the file from the repository and store the value in a secret manager or OS credential store.'

/**
 * File-level detection: sensitive filenames identified by basename alone.
 * A matching filename blocks a commit/sync at `critical`/`high`.
 */
export const FILE_SECRET_PATTERNS: readonly FileSecretPattern[] = [
  {
    id: 'private-key-file',
    name: 'Private key file',
    severity: CRITICAL,
    findingScope: 'file',
    globs: ['*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore'],
    description: 'A PEM/PKCS key material file.',
    recommendation:
      'Never commit private keys. Rotate the key if it was ever exposed and store it in a keychain.',
  },
  {
    id: 'ssh-private-key',
    name: 'SSH private key',
    severity: CRITICAL,
    findingScope: 'file',
    globs: ['id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519'],
    description: 'An SSH private key file.',
    recommendation:
      'Never commit SSH private keys. Remove it, rotate the key, and rely on the agent/keychain for credentials.',
  },
  {
    id: 'dotenv-file',
    name: '.env file',
    severity: HIGH,
    findingScope: 'file',
    globs: ['.env', '.env.*'],
    description: 'An environment file that typically holds secrets.',
    recommendation:
      'Keep secrets out of tracked files; use a gitignored local .env and shared .env.example.',
  },
  {
    id: 'credential-file',
    name: 'Credential / secret file',
    severity: HIGH,
    findingScope: 'file',
    globs: [
      'credentials.json',
      'credentials.yaml',
      'credentials.yml',
      'secrets.yaml',
      'secrets.yml',
    ],
    description: 'A file dedicated to credentials or secrets.',
    recommendation: CREDENTIAL_FILE_RECOMMENDATION,
  },
]

const CONTENT_RECOMMENDATION =
  'Revoke the exposed credential, then sync again. Secrets belong in a secret manager, not in Git history.'

const PRIVATE_KEY_RECOMMENDATION =
  'Revoke the key pair, remove the key material, and never commit private keys.'

/**
 * Content-level detection: regex patterns applied line-by-line. Every match
 * is reported once per (pattern, line). The snippets in the result are
 * masked so the real secret never leaves the scan output.
 */
export const CONTENT_SECRET_PATTERNS: readonly ContentSecretPattern[] = [
  {
    id: 'private-key-block',
    name: 'Private key block',
    severity: CRITICAL,
    findingScope: 'content',
    regex: /-----BEGIN[A-Z0-9 _]*PRIVATE KEY[A-Z0-9 _]*-----/u,
    description: 'An OpenSSL/OpenSSH private key block.',
    recommendation: PRIVATE_KEY_RECOMMENDATION,
  },
  {
    id: 'github-pat',
    name: 'GitHub personal access token',
    severity: HIGH,
    findingScope: 'content',
    regex: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
    description: 'A GitHub fine-grained or classic access token.',
    recommendation: CONTENT_RECOMMENDATION,
  },
  {
    id: 'openai-api-key',
    name: 'OpenAI API key',
    severity: HIGH,
    findingScope: 'content',
    regex: /\bsk-(?:sk|proj)-[A-Za-z0-9_-]{20,}\b/u,
    description: 'An OpenAI platform API key.',
    recommendation: CONTENT_RECOMMENDATION,
  },
  {
    id: 'anthropic-api-key',
    name: 'Anthropic API key',
    severity: HIGH,
    findingScope: 'content',
    regex: /\bsk-ant-api03-[A-Za-z0-9_-]{20,}\b/u,
    description: 'An Anthropic console API key.',
    recommendation: CONTENT_RECOMMENDATION,
  },
  {
    id: 'stripe-live-key',
    name: 'Stripe live secret key',
    severity: HIGH,
    findingScope: 'content',
    regex: /\bsk_live_[A-Za-z0-9]{16,}\b/u,
    description: 'A Stripe live secret key.',
    recommendation: CONTENT_RECOMMENDATION,
  },
  {
    id: 'aws-access-key',
    name: 'AWS access key ID',
    severity: HIGH,
    findingScope: 'content',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u,
    description: 'An AWS access key ID.',
    recommendation: CONTENT_RECOMMENDATION,
  },
  {
    id: 'aws-secret-key',
    name: 'AWS secret access key',
    severity: HIGH,
    findingScope: 'content',
    regex: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*[A-Za-z0-9/+=]{40}/u,
    description: 'An AWS secret access key value.',
    recommendation: CONTENT_RECOMMENDATION,
  },
  {
    id: 'google-api-key',
    name: 'Google API key',
    severity: HIGH,
    findingScope: 'content',
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/u,
    description: 'A Google Cloud API key.',
    recommendation: CONTENT_RECOMMENDATION,
  },
  {
    id: 'slack-token',
    name: 'Slack token',
    severity: HIGH,
    findingScope: 'content',
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u,
    description: 'A Slack bot/user/app token.',
    recommendation: CONTENT_RECOMMENDATION,
  },
  {
    id: 'telegram-bot-token',
    name: 'Telegram bot token',
    severity: HIGH,
    findingScope: 'content',
    regex: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/u,
    description: 'A Telegram bot API token.',
    recommendation: CONTENT_RECOMMENDATION,
  },
  {
    id: 'generic-bearer',
    name: 'Generic bearer token',
    severity: MEDIUM,
    findingScope: 'content',
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/u,
    description: 'A bearer token literal in code.',
    recommendation: CONTENT_RECOMMENDATION,
  },
  {
    id: 'jwt-token',
    name: 'JWT token',
    severity: MEDIUM,
    findingScope: 'content',
    regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}\b/u,
    description: 'A JSON Web Token embedded in source.',
    recommendation: CONTENT_RECOMMENDATION,
  },
  {
    id: 'slack-webhook',
    name: 'Slack webhook URL',
    severity: MEDIUM,
    findingScope: 'content',
    regex: /hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+/u,
    description: 'An incoming Slack webhook URL.',
    recommendation: CONTENT_RECOMMENDATION,
  },
  {
    id: 'credential-placeholder',
    name: 'Credential placeholder',
    severity: LOW,
    findingScope: 'content',
    regex:
      /\b(?:password|passwd|secret|api[-_]?key|access[-_]?token|client[-_]?secret|private[-_]?key)\b\s*[=:]\s*(?:''|""|'xxx+'|"xxx+"|xxx+|XXX+|your_|changeme|placeholder|TODO|<[^>]+>|\*{3,})/u,
    description: 'A credential assignment that holds an empty or placeholder value.',
    recommendation: 'Replace the placeholder with a real value or remove the assignment.',
  },
]
