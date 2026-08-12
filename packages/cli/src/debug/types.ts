export interface DebugBundleInput {
  repositoryRoot: string
  homeRoot: string
}

export interface DebugBundleResult {
  outputFile: string
  generatedAt: string
}

/** Injectable public boundary behind `skillbox debug-bundle`. */
export interface DebugBundleProvider {
  create(input: DebugBundleInput): Promise<DebugBundleResult>
}
