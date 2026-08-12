import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { SkillboxError, ErrorCode } from '../errors.js'
import { isInsideRoot } from '../fs/paths.js'
import type { SnapshotTarget } from './types.js'

export type CapturedPathKind = SnapshotTarget['kind'] | 'link'

/** A durable description of a single filesystem location before mutation. */
export interface OperationSnapshot {
  version: 1
  targetPath: string
  storagePath: string
  target: SnapshotTarget
  capturedKind: CapturedPathKind
  /** Raw link text. It is intentionally never resolved or followed. */
  linkTarget?: string
}

export interface CaptureSnapshotOptions {
  targetPath: string
  /** Dedicated empty location in which this snapshot stores a copied payload. */
  storagePath: string
  /** Every target and payload path must lexically reside below one of these roots. */
  allowedRoots: readonly string[]
}

export interface RestoreSnapshotOptions {
  snapshot: OperationSnapshot
  allowedRoots: readonly string[]
}

/**
 * Captures missing, regular-file, directory and directory-link states without
 * following links. The payload is stored under `storagePath/payload`.
 */
export async function captureSnapshot(options: CaptureSnapshotOptions): Promise<OperationSnapshot> {
  const targetPath = assertAllowedPath(options.targetPath, options.allowedRoots, 'target')
  const storagePath = assertAllowedPath(options.storagePath, options.allowedRoots, 'storage')
  if (isSameOrNested(targetPath, storagePath) || isSameOrNested(storagePath, targetPath)) {
    throw invalidSnapshot('Snapshot storage and target must not contain one another')
  }

  await fs.rm(storagePath, { recursive: true, force: true })
  await fs.mkdir(storagePath, { recursive: true })
  const payloadPath = path.join(storagePath, 'payload')
  let stats: import('node:fs').Stats
  try {
    stats = await fs.lstat(targetPath)
  } catch (error) {
    if (isNotFound(error)) {
      return createSnapshot(targetPath, storagePath, 'absent')
    }
    throw invalidSnapshot(`Unable to inspect snapshot target "${targetPath}"`, error)
  }

  if (stats.isSymbolicLink()) {
    return {
      ...createSnapshot(targetPath, storagePath, 'directory'),
      capturedKind: 'link',
      linkTarget: await fs.readlink(targetPath),
    }
  }
  if (stats.isFile()) {
    await fs.copyFile(targetPath, payloadPath)
    return createSnapshot(targetPath, storagePath, 'file')
  }
  if (stats.isDirectory()) {
    await fs.cp(targetPath, payloadPath, { recursive: true, dereference: false, force: true })
    return createSnapshot(targetPath, storagePath, 'directory')
  }
  throw invalidSnapshot(`Cannot snapshot special filesystem entry "${targetPath}"`)
}

/** Restores a snapshot exactly; calling it repeatedly produces the same state. */
export async function restoreSnapshot(options: RestoreSnapshotOptions): Promise<void> {
  const snapshot = options.snapshot
  if (!isOperationSnapshot(snapshot)) throw invalidSnapshot('Snapshot record is invalid')
  const targetPath = assertAllowedPath(snapshot.targetPath, options.allowedRoots, 'target')
  const storagePath = assertAllowedPath(snapshot.storagePath, options.allowedRoots, 'storage')
  if (isSameOrNested(targetPath, storagePath) || isSameOrNested(storagePath, targetPath)) {
    throw invalidSnapshot('Snapshot storage and target must not contain one another')
  }

  await fs.rm(targetPath, { recursive: true, force: true })
  if (snapshot.capturedKind === 'absent') return
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  if (snapshot.capturedKind === 'link') {
    await fs.symlink(
      snapshot.linkTarget!,
      targetPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    return
  }
  const payloadPath = path.join(storagePath, 'payload')
  if (!isInsideAllowedRoot(payloadPath, options.allowedRoots)) {
    throw invalidSnapshot('Snapshot payload is outside an allowed root')
  }
  try {
    await fs.cp(payloadPath, targetPath, { recursive: true, dereference: false, force: true })
  } catch (error) {
    throw invalidSnapshot(`Snapshot payload is missing or unreadable at "${payloadPath}"`, error)
  }
}

export function isOperationSnapshot(value: unknown): value is OperationSnapshot {
  if (typeof value !== 'object' || value === null) return false
  const snapshot = value as Record<string, unknown>
  const kind = snapshot['capturedKind']
  return (
    snapshot['version'] === 1 &&
    typeof snapshot['targetPath'] === 'string' &&
    typeof snapshot['storagePath'] === 'string' &&
    typeof snapshot['target'] === 'object' &&
    snapshot['target'] !== null &&
    ['file', 'directory', 'absent', 'link'].includes(kind as string) &&
    (kind !== 'link' || typeof snapshot['linkTarget'] === 'string')
  )
}

function createSnapshot(
  targetPath: string,
  storagePath: string,
  kind: SnapshotTarget['kind'],
): OperationSnapshot {
  return {
    version: 1,
    targetPath,
    storagePath,
    target: { path: targetPath, kind },
    capturedKind: kind,
  }
}

function assertAllowedPath(
  candidate: string,
  allowedRoots: readonly string[],
  label: string,
): string {
  if (!isInsideAllowedRoot(candidate, allowedRoots)) {
    throw invalidSnapshot(`Snapshot ${label} must be inside an explicitly allowed root`)
  }
  return path.resolve(candidate)
}

function isInsideAllowedRoot(candidate: string, allowedRoots: readonly string[]): boolean {
  return allowedRoots.some((root) => isInsideRoot(path.resolve(root), path.resolve(candidate)))
}

function isSameOrNested(parent: string, child: string): boolean {
  return path.resolve(parent) === path.resolve(child) || isInsideRoot(parent, child)
}

function isNotFound(error: unknown): error is NodeJS.ErrnoException {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  )
}

function invalidSnapshot(message: string, cause?: unknown): SkillboxError {
  return new SkillboxError(ErrorCode.OPERATION_SNAPSHOT_INVALID, message, { cause })
}
