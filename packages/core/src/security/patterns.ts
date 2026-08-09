import type { SecurityFindingScope, SecurityRiskLevel } from './types.js'

export interface SecurityPatternBase {
  id: string
  name: string
  risk: SecurityRiskLevel
  findingScope: SecurityFindingScope
  description: string
  recommendation: string
}

export interface ContentSecurityPattern extends SecurityPatternBase {
  /** Case-sensitive regex, matched once per line (no `/g` flag). */
  regex: RegExp
  findingScope: 'content'
}

export interface FileSecurityPattern extends SecurityPatternBase {
  /** Basename globs (gitignore-style, no `/`), matched case-insensitively. */
  globs: readonly string[]
  findingScope: 'file'
}

const HIGH = 'high' as const
const MEDIUM = 'medium' as const
const LOW = 'low' as const

const NETWORK_RECOMMENDATION =
  'Review the network calls; skills should not exfiltrate data or phone home during a run.'
const SHELL_RECOMMENDATION =
  'Shell execution from a skill can run arbitrary commands. Prefer documented, reviewable steps and avoid piping a downloaded script into a shell.'
const WRITE_RECOMMENDATION =
  'Destructive file operations remove data. Verify they only touch paths inside the user-sanctioned workspace.'
const CREDENTIAL_RECOMMENDATION =
  'Reading credentials increases the reach of a skill. Confirm the values come from the user environment, never from an attacker-controlled source.'

/**
 * Content-level Security Scan patterns: machine-execution, network, file
 * writes and credential access. Applied line-by-line over every text file in
 * the skill; one finding per (pattern, line).
 *
 * Exposure is intentionally broader than the Secret Scanner (which looks for
 * committed secrets) — this catalog flags risky *behaviour* before install.
 */
export const CONTENT_SECURITY_PATTERNS: readonly ContentSecurityPattern[] = [
  /* --- shell execution --- */
  {
    id: 'shell-exec',
    name: 'Shell command execution',
    risk: HIGH,
    findingScope: 'content',
    regex:
      /\b(?:child_process(?:\.exec|\.execSync|\.spawn|\.spawnSync|\.fork)?|execSync|spawnSync|spawn|exec)\s*\(/u,
    description: 'Spawns a shell command or child process (exec/spawn/child_process).',
    recommendation: SHELL_RECOMMENDATION,
  },
  {
    id: 'curl-bash-pipe',
    name: 'Remote script downloaded into a shell',
    risk: HIGH,
    findingScope: 'content',
    // Allows common flags between the tool and the URL (`curl -fsSL URL | bash`).
    regex:
      /\b(?:curl|wget)\s+(?:-\w+\s+)*["']?https?[^\s|&;]+["']?\s*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash)\b/u,
    description: 'Pipes a downloaded remote script directly into a shell interpreter.',
    recommendation: SHELL_RECOMMENDATION,
  },
  {
    id: 'invoke-command',
    name: 'PowerShell remote command execution',
    risk: MEDIUM,
    findingScope: 'content',
    regex: /\b(?:powershell|pwsh|start-process)\s+(?:-noprofile\s+-command\s+|-command\s+)?["']/iu,
    description: 'Invokes a PowerShell command or starts a process from the skill.',
    recommendation:
      'Confirm the PowerShell invocation target is a trusted, reviewed script rather than arbitrary input.',
  },

  /* --- network --- */
  {
    id: 'network-request',
    name: 'Network request',
    risk: MEDIUM,
    findingScope: 'content',
    regex: /\b(?:fetch|axios|got)\s*\(|https?\.request\s*\(|\bhttps?:\/\/\S+/u,
    description: 'Opens an outbound HTTP(S) connection.',
    recommendation: NETWORK_RECOMMENDATION,
  },
  {
    id: 'invoke-webrequest',
    name: 'PowerShell web request',
    risk: MEDIUM,
    findingScope: 'content',
    regex: /\bInvoke-(?:WebRequest|RestMethod)|New-Object\s+Net\.WebClient/iu,
    description: 'Performs a web request inside a PowerShell command.',
    recommendation: NETWORK_RECOMMENDATION,
  },

  /* --- file system writes / destructive operations --- */
  {
    id: 'fs-write',
    name: 'File system write',
    risk: MEDIUM,
    findingScope: 'content',
    regex:
      /\b(?:fs\.)?(?:writeFile|writeFileSync|appendFile|appendFileSync|mkdirSync?|outputFile(?:Sync)?|writeJson(?:Sync)?)\s*\(/u,
    description: 'Writes to the file system.',
    recommendation:
      'File writes are common in skills, but verify paths stay inside the intended workspace.',
  },
  {
    id: 'fs-destructive',
    name: 'Destructive file removal',
    risk: HIGH,
    findingScope: 'content',
    regex:
      /\b(?:fs\.)?(?:rm\s*\(|rmSync\s*\(|unlink\s*\(|unlinkSync\s*\(|rmdir(?:Sync)?\s*\(|remove(?:Sync)?\s*\()|\brm\s+-[a-z]*r[a-z]*\b|\bRemove-Item\b(?:[^\n]*-(?:Recurse|Force))?/iu,
    description: 'Deletes files or directories (fs.rm / unlink / rm -r / Remove-Item).',
    recommendation: WRITE_RECOMMENDATION,
  },

  /* --- credential access --- */
  {
    id: 'env-credential-read',
    name: 'Environment credential read',
    risk: HIGH,
    findingScope: 'content',
    regex:
      /\b(?:process\.env(?:\.|\[|\.get)|Deno\.env\.(?:get|toObject)|os\.environ(?:\.get|\[)|os\.getenv)\s*["']?[^"'\]\)\s]*[-_]?(?:token|secret|password|passwd|credential|api[_-]?key|access[_-]?key|auth)[^"'\]\)\s]*/iu,
    description: 'Reads a credential-looking value from the process environment.',
    recommendation: CREDENTIAL_RECOMMENDATION,
  },
  {
    id: 'credential-var-read',
    name: 'Credential variable read',
    risk: MEDIUM,
    findingScope: 'content',
    regex:
      /\b(?:password|passwd|secret|token|credential|api[_-]?key|access[_-]?key|client[_-]?secret)\s*(?:=|:)\s*["'][^"']+["']/iu,
    description: 'Assigns or references a credential value in code.',
    recommendation: CREDENTIAL_RECOMMENDATION,
  },
  {
    id: 'ssh-credential-path',
    name: 'SSH / keychain credential path access',
    risk: HIGH,
    findingScope: 'content',
    regex: /(?:~\/\.ssh|\\Users\\[^\\]+\\.ssh|\.ssh\\[a-z_]+|\/home\/[^/]+\/\.ssh|\/root\/\.ssh)/iu,
    description: 'References SSH private-key locations or OS keychain stores.',
    recommendation: CREDENTIAL_RECOMMENDATION,
  },
  {
    id: 'kms-credential-read',
    name: 'Cloud credential store access',
    risk: MEDIUM,
    findingScope: 'content',
    regex:
      /\b(?:getSecretValue|aws\.secretsmanager|SecretManagerClient|GetSecretString|vault\.read|boto3\.client\(['"]secretsmanager)/u,
    description: 'Queries a cloud secrets manager or vault.',
    recommendation:
      'Only access the user cloud credentials the skill was explicitly scoped to use.',
  },
]

/**
 * File-level Security Scan patterns: risky file types identified by basename.
 * Lower-pressure than committed-secret file detection; these mainly give the
 * installer context (the content catalog drives the actual risk rating).
 */
export const FILE_SECURITY_PATTERNS: readonly FileSecurityPattern[] = [
  {
    id: 'shell-script-file',
    name: 'Executable shell script',
    risk: LOW,
    findingScope: 'file',
    globs: ['*.sh', '*.bash', '*.zsh', '*.bat', '*.cmd', '*.ps1'],
    description: 'A script that may run commands when executed.',
    recommendation:
      'Shell scripts can execute arbitrary commands; inspect them before trusting the skill.',
  },
]
