'use strict';

/**
 * Un tableau Docling est une liste de cellules positionnées (ligne/colonne de
 * départ, fusions). On le remet en grille de texte : une cellule fusionnée
 * remplit toute la zone qu'elle couvre, pour qu'aucune colonne ne glisse.
 */
function gridFromTable(table) {
  const data = table?.data;
  const cells = Array.isArray(data?.table_cells) ? data.table_cells : [];
  const numRows = data?.num_rows ?? 0;
  const numCols = data?.num_cols ?? 0;
  const rows = Array.from({ length: numRows }, () => Array(numCols).fill(''));
  for (const cell of cells) {
    const r0 = cell.start_row_offset_idx;
    const c0 = cell.start_col_offset_idx;
    const r1 = cell.end_row_offset_idx ?? r0 + 1;
    const c1 = cell.end_col_offset_idx ?? c0 + 1;
    for (let r = r0; r < r1 && r < numRows; r += 1) {
      for (let c = c0; c < c1 && c < numCols; c += 1) rows[r][c] = String(cell.text ?? '').trim();
    }
  }
  const headerRows = cells.length ? Math.max(0, ...cells.filter((c) => c.column_header).map((c) => c.end_row_offset_idx ?? c.start_row_offset_idx + 1)) : 0;
  return { rows, numRows, numCols, headerRows, page: table?.prov?.[0]?.page_no ?? null };
}

function extractTables(documentJson) {
  return Array.isArray(documentJson?.tables) ? documentJson.tables.map(gridFromTable) : [];
}

/** Tableau → Markdown (utile quand on ne veut que les tableaux, pas tout le document). */
function tableToMarkdown({ rows, headerRows }) {
  if (!rows.length) return '';
  const escape = (text) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const line = (row) => `| ${row.map(escape).join(' | ')} |`;
  const split = Math.max(1, headerRows);
  return [line(rows[0]), `| ${rows[0].map(() => '---').join(' | ')} |`, ...rows.slice(split > 1 ? split : 1).map(line)].join('\n');
}

module.exports = { extractTables, gridFromTable, tableToMarkdown };
