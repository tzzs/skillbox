import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  collectDiagnostics,
  probeGitCapability,
  probeNodeCapability,
  probeRepositoryFiles,
  type DiagnosticFilesystem,
  type DiagnosticGit,
} from './index.js'

const repositoryRoot = path.resolve('diagnostic-repository')

function filesystemWith(existing: readonly string[]): DiagnosticFilesystem {
  const paths = new Set(existing)
  return { exists: async (target) => paths.has(target) }
}

describe('diagnostics', () => {
  it('reports a supported Node runtime as ready', () => {
    expect(probeNodeCapability('20.11.1')).toMatchObject({
      id: 'node',
      status: 'pass',
      version: '20.11.1',
      minimumMajor: 20,
    })
  })

  it('reports an unsupported Node runtime without throwing', () => {
    expect(probeNodeCapability('18.20.4')).toMatchObject({
      id: 'node',
      status: 'fail',
      version: '18.20.4',
      minimumMajor: 20,
    })
  })

  it('reports whether Git is available and exposes its version', async () => {
    const git: DiagnosticGit = {
      isInstalled: async () => true,
      gitVersion: async () => 'git version 2.46.0',
    }

    await expect(probeGitCapability(git)).resolves.toMatchObject({
      id: 'git',
      status: 'pass',
      installed: true,
      version: 'git version 2.46.0',
    })
  })

  it('turns a Git probe failure into a structured failure', async () => {
    const git: DiagnosticGit = {
      isInstalled: async () => {
        throw new Error('spawn EACCES')
      },
      gitVersion: async () => 'not reached',
    }

    await expect(probeGitCapability(git)).resolves.toMatchObject({
      id: 'git',
      status: 'fail',
      installed: false,
      detail: 'spawn EACCES',
    })
  })

  it('flags absent repository files as warnings while preserving their paths', async () => {
    const files = await probeRepositoryFiles(repositoryRoot, filesystemWith([]))

    expect(files).toEqual([
      {
        id: 'manifest',
        status: 'warn',
        present: false,
        path: path.join(repositoryRoot, 'skillbox.yaml'),
      },
      {
        id: 'lockfile',
        status: 'warn',
        present: false,
        path: path.join(repositoryRoot, 'skillbox.lock'),
      },
    ])
  })

  it('combines every probe into an ordered public report', async () => {
    const git: DiagnosticGit = {
      isInstalled: async () => true,
      gitVersion: async () => 'git version 2.46.0',
    }
    const filesystem = filesystemWith([
      path.join(repositoryRoot, 'skillbox.yaml'),
      path.join(repositoryRoot, 'skillbox.lock'),
    ])

    await expect(
      collectDiagnostics({ repositoryRoot, nodeVersion: '22.14.0', git, filesystem }),
    ).resolves.toEqual({
      repositoryRoot,
      ready: true,
      checks: [
        {
          id: 'node',
          status: 'pass',
          version: '22.14.0',
          minimumMajor: 20,
        },
        {
          id: 'git',
          status: 'pass',
          installed: true,
          version: 'git version 2.46.0',
        },
        {
          id: 'manifest',
          status: 'pass',
          present: true,
          path: path.join(repositoryRoot, 'skillbox.yaml'),
        },
        {
          id: 'lockfile',
          status: 'pass',
          present: true,
          path: path.join(repositoryRoot, 'skillbox.lock'),
        },
      ],
    })
  })
})
