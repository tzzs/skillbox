import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Logger, defaultLogFilePath, formatLogLine } from './logger.js'
import { setGlobalVerbosity, shouldLog } from './levels.js'
import { REDACTED, isSensitiveKey, safeSerialize, scrubText } from './redact.js'

describe('shouldLog', () => {
  it('is silent at normal verbosity for verbose and debug messages', () => {
    expect(shouldLog('normal', 'error')).toBe(true)
    expect(shouldLog('normal', 'warn')).toBe(true)
    expect(shouldLog('normal', 'info')).toBe(true)
    expect(shouldLog('normal', 'verbose')).toBe(false)
    expect(shouldLog('normal', 'debug')).toBe(false)
  })

  it('unlocks verbose details at verbose verbosity', () => {
    expect(shouldLog('verbose', 'verbose')).toBe(true)
    expect(shouldLog('verbose', 'debug')).toBe(false)
  })

  it('emits everything at debug verbosity', () => {
    expect(shouldLog('debug', 'debug')).toBe(true)
    expect(shouldLog('debug', 'error')).toBe(true)
  })
})

describe('log redaction', () => {
  it('recognises well-known secret key shapes', () => {
    expect(isSensitiveKey('accessToken')).toBe(true)
    expect(isSensitiveKey('client_secret')).toBe(true)
    expect(isSensitiveKey('APIKey')).toBe(true)
    expect(isSensitiveKey('authorization')).toBe(true)
    expect(isSensitiveKey('skillName')).toBe(false)
  })

  it('masks sensitive keys during serialization', () => {
    expect(safeSerialize({ token: 'abc' })).toContain(REDACTED)
    expect(safeSerialize({ nested: { api_key: 'x' } })).toContain(REDACTED)
    expect(safeSerialize({ name: 'skill' })).toBe('{"name":"skill"}')
  })

  it('scrubs bearer tokens and key=value snippets from text', () => {
    expect(scrubText('token=abc123')).toContain(REDACTED)
    expect(scrubText('Authorization: Bearer xyz==')).toContain(REDACTED)
    expect(scrubText('plain message')).toBe('plain message')
  })

  it('falls back to the redacted marker for circular structures', () => {
    const circular: Record<string, unknown> = { self: null }
    circular.self = circular
    expect(safeSerialize(circular)).toBe(REDACTED)
  })
})

describe('formatLogLine', () => {
  it('renders an ISO timestamp, severity and scrubbed message', () => {
    const line = formatLogLine(new Date('2026-01-01T00:00:00Z'), 'debug', 'token=sekrit')
    expect(line).toContain('DEBUG')
    expect(line).toContain('2026-01-01T00:00:00.000Z')
    expect(line).toContain(REDACTED)
    expect(line).not.toContain('sekrit')
  })
})

describe('Logger', () => {
  it('only emits messages for the current verbosity', () => {
    const chunks: string[] = []
    const logger = new Logger({
      verbosity: 'verbose',
      emit: (chunk) => chunks.push(chunk),
    })
    logger.error('boom')
    logger.info('kept')
    logger.debug('dropped')
    expect(chunks.join('')).toContain('kept')
    expect(chunks.join('')).toContain('boom')
    expect(chunks.join('')).not.toContain('dropped')
  })

  it('respects explicit per-instance verbosity over the global default', () => {
    const chunks: string[] = []
    const logger = new Logger({
      verbosity: 'normal',
      emit: (chunk) => chunks.push(chunk),
    })
    logger.debug('hidden')
    expect(chunks.join('')).not.toContain('hidden')
  })

  it('appends emitted lines to the configured log file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'skillbox-log-'))
    try {
      const file = path.join(dir, 'skillbox.log')
      const logger = new Logger({ verbosity: 'debug', logFile: file })
      logger.warn('written')
      await logger.flush()
      const content = await readFile(file, 'utf8')
      expect(content).toContain('written')
      expect(content).toMatch(/WARN\s+written/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('never writes secrets to the log file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'skillbox-log-'))
    try {
      const file = path.join(dir, 'skillbox.log')
      const logger = new Logger({ verbosity: 'debug', logFile: file })
      logger.info('token leaked?', { token: 'super-secret' })
      await logger.flush()
      const content = await readFile(file, 'utf8')
      expect(content).not.toContain('super-secret')
      expect(content).toContain(REDACTED)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('falls back to the global verbosity when none is specified', () => {
    const chunks: string[] = []
    const logger = new Logger({ emit: (chunk) => chunks.push(chunk) })
    const before = chunks.join('')
    expect(before).not.toContain('hidden-by-default')
    logger.debug('hidden-by-default')

    setGlobalVerbosity('debug')
    const logger2 = new Logger({ emit: (chunk) => chunks.push(chunk) })
    logger2.debug('seen')
    logger2.debug('hidden')
    expect(chunks.join('')).toContain('seen')
    expect(chunks.join('')).not.toContain('hidden-by-default')
    setGlobalVerbosity('normal')
  })
})

describe('defaultLogFilePath', () => {
  it('resolves to the logs dir under the given home root', () => {
    expect(defaultLogFilePath('/tmp/root')).toMatch(/[\\/]root[\\/]logs[\\/]skillbox\.log$/)
  })
})
