import * as os from 'node:os'
import * as path from 'node:path'
import { FilesystemService } from '../fs/filesystem-service.js'
import { compareManifestToLockfile } from '../lockfile/consistency.js'
import { readLockfile } from '../lockfile/index.js'
import { readManifest } from '../manifest/index.js'
import { createCredentialStore } from '../github/credential-store.js'
import { RuntimeLinkState } from '../runtime/links.js'
import { RuntimeLibraryService } from '../runtime/library.js'
import { buildSkillboxHomeLayout } from '../runtime/paths.js'
import { RuntimeConfigService } from '../runtime/config.js'
import { GitClient } from '../git/index.js'
import { SkillboxHome } from '../runtime/home.js'
import type { AgentRegistry } from '../agent/index.js'
import type { ProbeResult } from './types.js'

export interface DoctorProbeContext {
  repositoryRoot: string
  homeRoot: string
  registry: AgentRegistry
  filesystem?: FilesystemService
}

/**
 * Runs every doctor probe (roadmap 5.3): git / node / home / config /
 * manifest / lockfile / consistency / agents / library / links / credentials.
 * Probes never throw — each failure becomes a `ProbeResult` with a scrubbed
 * message, so `skillbox doctor` always renders a full report.
 */
export async function runDoctorProbes(context: DoctorProbeContext): Promise<ProbeResult[]> {
  const filesystem = context.filesystem ?? new FilesystemService()
  const layout = buildSkillboxHomeLayout(context.homeRoot)
  const probes: ProbeResult[] = []
  const push = (result: ProbeResult): void => {
    probes.push(result)
  }

  /* git binary */
  const git = new GitClient()
  try {
    const version = await git.gitVersion()
    push({ name: 'git', ok: true, detail: version })
  } catch (error) {
    push({ name: 'git', ok: false, error: messageOf(error) })
  }

  /* node */
  push({ name: 'node', ok: true, detail: process.version })

  /* platform */
  push({ name: 'platform', ok: true, detail: `${os.platform()} ${os.arch()}` })

  /* home dir writable */
  try {
    await filesystem.mkdir(layout.state)
    const probeFile = path.join(layout.state, '.doctor-probe')
    await filesystem.writeFile(probeFile, 'ok\n')
    await filesystem.remove(probeFile)
    push({ name: 'home', ok: true, detail: context.homeRoot })
  } catch (error) {
    push({ name: 'home', ok: false, error: messageOf(error) })
  }

  /* machine config */
  try {
    const config = new RuntimeConfigService({
      configFilePath: new SkillboxHome({ root: context.homeRoot }).configFilePath(),
      filesystem,
    })
    const loaded = await config.load()
    push({ name: 'config', ok: true, detail: `repository: ${loaded.repository ?? '(none)'}` })
  } catch (error) {
    push({ name: 'config', ok: false, error: messageOf(error) })
  }

  /* manifest */
  let manifestSkills = 0
  try {
    const manifest = await readManifest(context.repositoryRoot)
    manifestSkills = Object.keys(manifest.skills).length
    push({ name: 'manifest', ok: true, detail: `${manifestSkills} skill(s)` })
  } catch (error) {
    push({ name: 'manifest', ok: false, error: messageOf(error) })
  }

  /* lockfile */
  let lockfileSkills = 0
  let lockfileOk = false
  try {
    const lockfile = await readLockfile(context.repositoryRoot)
    lockfileSkills = Object.keys(lockfile.skills).length
    lockfileOk = true
    push({ name: 'lockfile', ok: true, detail: `${lockfileSkills} skill(s)` })
  } catch (error) {
    push({ name: 'lockfile', ok: false, error: messageOf(error) })
  }

  /* manifest ⇄ lockfile consistency */
  if (manifestSkills > 0 && lockfileOk) {
    try {
      const manifest = await readManifest(context.repositoryRoot)
      const lockfile = await readLockfile(context.repositoryRoot)
      const check = compareManifestToLockfile(manifest, lockfile)
      const problems = [
        ...check.missingFromLockfile.map((alias) => `${alias} missing from lockfile`),
        ...check.mismatchedSources.map((alias) => `${alias} source mismatch`),
      ]
      push({
        name: 'consistency',
        ok: problems.length === 0,
        ...(problems.length === 0
          ? { detail: 'manifest and lockfile agree' }
          : { error: problems.join('; ') }),
      })
    } catch (error) {
      push({ name: 'consistency', ok: false, error: messageOf(error) })
    }
  } else {
    push({ name: 'consistency', ok: true, detail: 'skipped (no manifest/lockfile pair)' })
  }

  /* agents */
  try {
    const detections = await context.registry.detectAll()
    const detected = detections.filter((agent) => agent.detected)
    push({
      name: 'agents',
      ok: true,
      detail:
        detected.length > 0
          ? detected
              .map((agent) => `${agent.id} (${agent.skillDirectories.length} dir(s))`)
              .join(', ')
          : 'none detected',
    })
  } catch (error) {
    push({ name: 'agents', ok: false, error: messageOf(error) })
  }

  /* library */
  try {
    const library = new RuntimeLibraryService(layout.library, filesystem)
    const entries = await library.list()
    push({ name: 'library', ok: true, detail: `${entries.length} materialized skill(s)` })
  } catch (error) {
    push({ name: 'library', ok: false, error: messageOf(error) })
  }

  /* links state */
  try {
    const links = new RuntimeLinkState({ filePath: layout.linksFile, filesystem })
    const database = await links.load()
    const rows = Object.keys(database).length
    push({ name: 'links', ok: true, detail: `${rows} agent(s) with recorded links` })
  } catch (error) {
    push({ name: 'links', ok: false, error: messageOf(error) })
  }

  /* credential store */
  try {
    const store = createCredentialStore({ secretsDir: path.join(layout.state, 'secrets') })
    const probeKey = { service: 'skillbox-doctor', account: 'probe' }
    await store.set(probeKey, 'probe')
    await store.get(probeKey)
    await store.delete(probeKey)
    push({ name: 'credentials', ok: true, detail: 'credential store available' })
  } catch (error) {
    push({ name: 'credentials', ok: false, error: messageOf(error) })
  }

  return probes
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
