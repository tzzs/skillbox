/**
 * Porcelain XY status letter sets (git `--porcelain=v1`).
 * The index letter (X) describes the staged state, the worktree letter (Y)
 * the unstaged state.
 */

const STAGED_LETTERS = new Set(['M', 'A', 'D', 'R', 'C', 'T', 'U'])
const UNSTAGED_LETTERS = new Set(['M', 'D', 'T', '?'])

/**
 * A merge conflict is reported by git when either column holds `U`
 * (`UU`/`AA`/`DD`/`UA`/`AU`/`DU`/`UD`).
 */
export function isGitXyConflict(xy: string): boolean {
  return xy.length >= 2 && (xy[0] === 'U' || xy[1] === 'U')
}

/** True when the index column (X) of an XY code holds a staged change. */
export function isIndexChange(xy: string): boolean {
  const code = xy[0]
  return code !== undefined && STAGED_LETTERS.has(code)
}

/** True when the worktree column (Y) of an XY code holds an unstaged change. */
export function isWorktreeChange(xy: string): boolean {
  const code = xy[1]
  return code !== undefined && UNSTAGED_LETTERS.has(code)
}
