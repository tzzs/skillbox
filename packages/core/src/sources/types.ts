import type { ManifestSkillSource } from '../manifest/schema.js'

/**
 * The one lossless source model used by new Core callers.  Its discriminants
 * intentionally match the manifest schema so crossing that boundary cannot
 * discard a Git or non-skills.sh Registry source.
 */
export type CanonicalSkillSource = ManifestSkillSource

export type SkillSourceType = CanonicalSkillSource['type']

/** The operations an adapter can perform for a source kind. */
export interface SkillSourceCapabilities {
  resolve: boolean
  download: boolean
  latest: boolean
  materialize: boolean
}

export interface ResolvedSkillSource {
  source: CanonicalSkillSource
  revision: string
  integrity?: string
}

/**
 * Narrow provider contract.  An adapter advertises unsupported operations in
 * its capabilities instead of making callers infer support from method shape.
 */
export interface SkillSourceAdapter {
  readonly type: SkillSourceType
  readonly capabilities: SkillSourceCapabilities
  resolve?(source: CanonicalSkillSource): Promise<ResolvedSkillSource>
  download?(source: CanonicalSkillSource, revision: string, targetDir: string): Promise<void>
  latest?(source: CanonicalSkillSource): Promise<string>
  materialize?(source: CanonicalSkillSource, revision: string, targetDir: string): Promise<void>
}

export interface SkillSourceResolver {
  parse(input: string): CanonicalSkillSource
  serialize(source: CanonicalSkillSource): string
  fromManifest(source: ManifestSkillSource): CanonicalSkillSource
  toManifest(source: CanonicalSkillSource): ManifestSkillSource
  capabilitiesFor(source: CanonicalSkillSource): SkillSourceCapabilities
  adapterFor(
    source: CanonicalSkillSource,
    capability?: keyof SkillSourceCapabilities,
  ): SkillSourceAdapter
}
