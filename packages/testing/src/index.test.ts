import { access } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { createTempDir, removeTempDir } from './index.js'

describe('testing', () => {
  it('creates a temp directory and removes it afterwards', async () => {
    const dir = await createTempDir()
    await expect(access(dir)).resolves.toBeUndefined()
    await removeTempDir(dir)
    await expect(access(dir)).rejects.toThrow()
  })
})
