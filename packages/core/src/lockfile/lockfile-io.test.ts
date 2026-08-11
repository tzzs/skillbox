import { describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { ErrorCode } from '../errors.js'
import { isSkillboxError } from '../errors.js'
import { withTempDir } from '../fs/test-utils.js'
import { readLockfile, serializeLockfile, writeLockfile } from './lockfile-io.js'
import { emptyLockfile, createLockedSkill, type SkillboxLockfile } from './schema.js'

describe('readLockfile', () => {
  it('throws LOCKFILE_NOT_FOUND when the file is missing', async () => {
    await withTempDir(async (dir) => {
      try {
        await readLockfile(dir)
        expect.unreachable('expected readLockfile to throw')
      } catch (error) {
        expect(isSkillboxError(error)).toBe(true)
        expect(error).toMatchObject({ code: ErrorCode.LOCKFILE_NOT_FOUND })
      }
    })
  })

  it('throws INVALID_LOCKFILE for invalid YAML', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'skillbox.lock'), '::: [', 'utf8')
      await expect(readLockfile(dir)).rejects.toMatchObject({ code: ErrorCode.INVALID_LOCKFILE })
    })
  })

  it('throws INVALID_LOCKFILE for a non-mapping document', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'skillbox.lock'), '"just a string"\n', 'utf8')
      await expect(readLockfile(dir)).rejects.toMatchObject({ code: ErrorCode.INVALID_LOCKFILE })
    })
  })

  it('throws INVALID_LOCKFILE when lockfileVersion is missing', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(path.join(dir, 'skillbox.lock'), 'skills: {}\n', 'utf8')
      await expect(readLockfile(dir)).rejects.toMatchObject({ code: ErrorCode.INVALID_LOCKFILE })
    })
  })

  it('throws UNSUPPORTED_LOCKFILE_VERSION for a newer version', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, 'skillbox.lock'),
        'lockfileVersion: 2\nskills: {}\n',
        'utf8',
      )
      await expect(readLockfile(dir)).rejects.toMatchObject({
        code: ErrorCode.UNSUPPORTED_LOCKFILE_VERSION,
        context: { version: 2 },
      })
    })
  })

  it('throws INVALID_LOCKFILE for a schema-invalid document', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, 'skillbox.lock'),
        'lockfileVersion: 1\nskills: { broken: { mode: managed } }\n',
        'utf8',
      )
      try {
        await readLockfile(dir)
        expect.unreachable('expected readLockfile to throw')
      } catch (error) {
        expect(isSkillboxError(error)).toBe(true)
        expect(error).toMatchObject({ code: ErrorCode.INVALID_LOCKFILE })
      }
    })
  })

  it('reads a minimal lockfile back', async () => {
    await withTempDir(async (dir) => {
      await fs.writeFile(
        path.join(dir, 'skillbox.lock'),
        'lockfileVersion: 1\nskills: {}\n',
        'utf8',
      )
      const lockfile = await readLockfile(dir)
      expect(lockfile.lockfileVersion).toBe(1)
      expect(lockfile.skills).toEqual({})
    })
  })
})

describe('serializeLockfile', () => {
  it('serializes the minimal lockfile deterministically', () => {
    const serialized = serializeLockfile(emptyLockfile())
    expect(serialized).toBe('lockfileVersion: 1\nskills: {}\n')
    expect(serialized.endsWith('\n')).toBe(true)
  })

  it('is byte-identical across calls', () => {
    const lockfile: SkillboxLockfile = {
      lockfileVersion: 1,
      generatedBy: 'skillbox@0.1.0',
      skills: {
        a: {
          mode: 'managed',
          source: { type: 'github', repo: 'a/b', ref: 'main' },
          revision: 'abc',
          integrity: 'sha256:' + 'c'.repeat(64),
        },
      },
    }
    expect(serializeLockfile(lockfile)).toBe(serializeLockfile(lockfile))
  })
})

describe('writeLockfile', () => {
  it('writes UTF-8 LF content and round-trips', async () => {
    await withTempDir(async (dir) => {
      const lockfile: SkillboxLockfile = {
        lockfileVersion: 1,
        generatedBy: 'skillbox@0.1.0',
        skills: {
          a: createLockedSkill({
            mode: 'local',
            source: { type: 'local', path: 'skills/a' },
            integrity: 'sha256:' + 'a'.repeat(64),
          }),
        },
      }
      await writeLockfile(dir, lockfile)
      const readBack = await readLockfile(dir)
      expect(readBack).toEqual(lockfile)
    })
  })

  it('is deterministic: writing the same input twice yields identical bytes', async () => {
    await withTempDir(async (dir) => {
      const lockfile: SkillboxLockfile = {
        lockfileVersion: 1,
        skills: {
          one: {
            mode: 'managed',
            source: { type: 'github', repo: 'a/b' },
            revision: '07a81df7',
            integrity: 'sha256:' + 'b'.repeat(64),
          },
          two: {
            mode: 'local',
            source: { type: 'local', path: 'skills/two' },
            integrity: 'sha256:' + 'c'.repeat(64),
          },
        },
      }
      await writeLockfile(dir, lockfile)
      const first = await fs.readFile(path.join(dir, 'skillbox.lock'))
      await writeLockfile(dir, lockfile)
      const second = await fs.readFile(path.join(dir, 'skillbox.lock'))
      expect(second).toEqual(first)
    })
  })

  it('serializes only portable, relative data (no absolute paths)', async () => {
    await withTempDir(async (dir) => {
      const lockfile: SkillboxLockfile = {
        lockfileVersion: 1,
        generatedBy: 'skillbox@0.1.0',
        skills: {
          a: createLockedSkill({
            mode: 'local',
            source: { type: 'local', path: path.join('skills', 'a') },
            integrity: 'sha256:' + 'a'.repeat(64),
          }),
        },
      }
      const serialized = serializeLockfile(lockfile)
      expect(serialized).not.toContain(dir)
    })
  })
})
