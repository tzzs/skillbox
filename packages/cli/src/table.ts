/**
 * Minimal aligned-text table for human-readable CLI output. Column widths are
 * derived from the header and the widest cell; cells are left-padded unless
 * the header is right-aligned.
 */
export function renderTable(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
): string {
  const columns = headers.map((header, columnIndex) => {
    const cells = rows.map((row) => String(row[columnIndex] ?? ''))
    const width = Math.max(header.length, ...cells.map((cell) => cell.length))
    return { header, cells, width }
  })

  const lines: string[] = []
  lines.push(columns.map((column) => column.header.padEnd(column.width)).join('  '))
  lines.push(columns.map((column) => '-'.repeat(column.width)).join('  '))
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    lines.push(
      columns.map((column) => (column.cells[rowIndex] ?? '').padEnd(column.width)).join('  '),
    )
  }
  return lines.join('\n')
}
