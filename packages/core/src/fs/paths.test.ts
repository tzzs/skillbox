import { describe, expect, it } from 'vitest'
import path from 'node:path'
import {
  validateRelativePath,
  resolveInsideRoot,
  isInsideRoot,
  isPortableRelativePath,
} from './paths.js'
import { SkillboxError } from './errors.js'
import { withTempDir } from './test-utils.js'

function expectUnsafePath(fn: () => unknown): void {
  try {
    fn()
    expect.unreachable('expected an UNSAFE_PATH error')
  } catch (error) {
    expect(error).toBeInstanceOf(SkillboxError)
    expect((error as SkillboxError).code).toBe('UNSAFE_PATH')
  }
}

describe('validateRelativePath', () => {
  it('accepts plain repository-relative paths', () => {
    expect(validateRelativePath('SKILL.md')).toBe('SKILL.md')
    expect(validateRelativePath('scripts/run.js')).toBe('scripts/run.js')
    expect(validateRelativePath('references/doc.md')).toBe('references/doc.md')
    expect(validateRelativePath('assets/icon.png')).toBe('assets/icon.png')
    expect(validateRelativePath('a skill with spaces.md')).toBe('a skill with spaces.md')
  })

  it('normalizes dot and duplicate separators', () => {
    expect(validateRelativePath('a//b')).toBe('a/b')
    expect(validateRelativePath('./a/b')).toBe('a/b')
    expect(validateRelativePath('a/./b')).toBe('a/b')
  })

  it('rejects empty input', () => {
    expectUnsafePath(() => validateRelativePath(''))
    expectUnsafePath(() => validateRelativePath('   '))
  })

  it('rejects POSIX path traversal', () => {
    expectUnsafePath(() => validateRelativePath('../../../etc/passwd'))
    expectUnsafePath(() => validateRelativePath('..'))
    expectUnsafePath(() => validateRelativePath('a/../../b'))
    expectUnsafePath(() => validateRelativePath('sub/../../super-secret'))
  })

  it('rejects absolute POSIX paths', () => {
    expectUnsafePath(() => validateRelativePath('/Users/foo'))
    expectUnsafePath(() => validateRelativePath('/etc/passwd'))
    expectUnsafePath(() => validateRelativePath('//server/share'))
  })

  it('rejects Windows drive escapes', () => {
    expectUnsafePath(() => validateRelativePath('C:\\Windows\\System32'))
    expectUnsafePath(() => validateRelativePath('C:/Windows/System32'))
    expectUnsafePath(() => validateRelativePath('c:\\Windows'))
    expectUnsafePath(() => validateRelativePath('D:/Users/foo'))
    expectUnsafePath(() => validateRelativePath('C:\\'))
  })

  it('rejects Windows absolute paths and UNC', () => {
    expectUnsafePath(() => validateRelativePath('\\Users\\foo'))
    expectUnsafePath(() => validateRelativePath('\\\\server\\share\\x'))
  })

  it('isPortableRelativePath mirrors validation without throwing', () => {
    expect(isPortableRelativePath('scripts/x.sh')).toBe(true)
    expect(isPortableRelativePath('../../../etc/passwd')).toBe(false)
    expect(isPortableRelativePath('C:\\Windows\\System32')).toBe(false)
    expect(isPortableRelativePath('/Users/foo')).toBe(false)
    expect(isPortableRelativePath('')).toBe(false)
  })
})

describe('resolveInsideRoot', () => {
  it('resolves a nested relative path inside the root', async () => {
    await withTempDir(async (root) => {
      const resolved = resolveInsideRoot(root, 'scripts/nested/run.js')
      expect(resolved).toBe(path.join(root, 'scripts', 'nested', 'run.js'))
    })
  })

  it('accepts backslash separators as portable relative input', async () => {
    await withTempDir(async (root) => {
      const resolved = resolveInsideRoot(root, 'scripts\\nested\\run.js')
      expect(resolved).toBe(path.join(root, 'scripts', 'nested', 'run.js'))
    })
  })

  it('throws UNSAFE_PATH on traversal', async () => {
    await withTempDir(async (root) => {
      expectUnsafePath(() => resolveInsideRoot(root, '../../../etc/passwd'))
      expectUnsafePath(() => resolveInsideRoot(root, '..'))
    })
  })

  it('throws UNSAFE_PATH on windows drive path', async () => {
    await withTempDir(async (root) => {
      expectUnsafePath(() => resolveInsideRoot(root, 'C:\\Windows\\System32'))
      expectUnsafePath(() => resolveInsideRoot(root, 'C:/Windows/System32'))
    })
  })

  it('throws UNSAFE_PATH on absolute path', async () => {
    await withTempDir(async (root) => {
      expectUnsafePath(() => resolveInsideRoot(root, '/tmp/evil'))
    })
  })
})

describe('isInsideRoot', () => {
  it('detects containment lexically', () => {
    const root = '/repo/skill'
    expect(isInsideRoot(root, path.join(root, 'scripts', 'a.js'))).toBe(true)
    expect(isInsideRoot(root, path.join(root, 'SKILL.md'))).toBe(true)
    expect(isInsideRoot(root, path.dirname(root))).toBe(false)
    expect(isInsideRoot(root, '/repo/other/file')).toBe(false)
  })
})
