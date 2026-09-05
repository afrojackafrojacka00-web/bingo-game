'use strict';

/** Rows and columns only (diagonals handled separately) */
const ROWS = [
  [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]],
  [[1, 0], [1, 1], [1, 2], [1, 3], [1, 4]],
  [[2, 0], [2, 1], [2, 2], [2, 3], [2, 4]],
  [[3, 0], [3, 1], [3, 2], [3, 3], [3, 4]],
  [[4, 0], [4, 1], [4, 2], [4, 3], [4, 4]],
];
const COLS = [
  [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],
  [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1]],
  [[0, 2], [1, 2], [2, 2], [3, 2], [4, 2]],
  [[0, 3], [1, 3], [2, 3], [3, 3], [4, 3]],
  [[0, 4], [1, 4], [2, 4], [3, 4], [4, 4]],
];
const DIAGONALS = [
  [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]],
  [[0, 4], [1, 3], [2, 2], [3, 1], [4, 0]],
];
const LINES = ROWS.concat(COLS).concat(DIAGONALS);
const CORNERS = [[0, 0], [0, 4], [4, 0], [4, 4]];

/** Built-in pattern templates admins can enable / tune */
const PATTERN_CATALOG = [
  { type: 'row_col_count', id: 'one_line', label: '1 row or 1 column', description: 'Exactly one completed row or column', minLines: 1, maxLines: 1, defaultMultiplier: 1 },
  { type: 'row_col_count', id: 'two_lines', label: '2+ rows/columns', description: 'Two or more completed rows/columns (capped display at 2 lines)', minLines: 2, maxLines: 99, defaultMultiplier: 2 },
  { type: 'diagonal', id: 'diagonal', label: '1 diagonal', description: 'Either main diagonal complete', defaultMultiplier: 1.5 },
  { type: 'both_diagonals', id: 'both_diagonals', label: 'Both diagonals (X)', description: 'Both diagonals complete', defaultMultiplier: 3 },
  { type: 'corners', id: 'four_corners', label: 'Four corners', description: 'All four corner cells', defaultMultiplier: 2.5 },
  { type: 'corners_plus_line', id: 'corners_plus_line', label: 'Corners + any line', description: 'Four corners plus any row, column, or diagonal', defaultMultiplier: 4 },
  { type: 'full_card', id: 'full_card', label: 'Full card (blackout)', description: 'Every cell marked', defaultMultiplier: 5 },
];

function defaultWinRules() {
  return PATTERN_CATALOG.map((p) => ({
    id: p.id,
    type: p.type,
    label: p.label,
    description: p.description,
    enabled: ['one_line', 'two_lines', 'diagonal', 'four_corners', 'corners_plus_line'].includes(p.id),
    multiplier: p.defaultMultiplier,
    minLines: p.minLines,
    maxLines: p.maxLines,
  }));
}

function cellMatched(grid, r, c, drawnSet) {
  const v = grid[r][c];
  if (v === 'FREE' || v === 0 || (r === 2 && c === 2)) return true;
  return drawnSet.has(Number(v));
}

function lineComplete(grid, drawnSet, cells) {
  return cells.every(([r, c]) => cellMatched(grid, r, c, drawnSet));
}

function uniqueCells(list) {
  const seen = new Set();
  const out = [];
  (list || []).forEach(([r, c]) => {
    const k = r + ',' + c;
    if (!seen.has(k)) { seen.add(k); out.push([r, c]); }
  });
  return out;
}

/**
 * Evaluate one card using admin-configured win rules.
 * Highest enabled matching multiplier wins.
 * @param {any[][]} grid
 * @param {number[]} drawnNumbers
 * @param {object[]} [rules] admin rules; falls back to defaults
 */
function evaluateCard(grid, drawnNumbers, rules) {
  const drawnSet = new Set((drawnNumbers || []).map(Number));
  if (!Array.isArray(grid) || grid.length < 5) {
    return { hit: false, pattern: null, multiplier: 0, winningCells: [] };
  }

  const activeRules = (Array.isArray(rules) && rules.length ? rules : defaultWinRules())
    .filter((r) => r && r.enabled !== false && Number(r.multiplier) > 0);

  const completedRows = ROWS.filter((line) => lineComplete(grid, drawnSet, line));
  const completedCols = COLS.filter((line) => lineComplete(grid, drawnSet, line));
  const completedDiags = DIAGONALS.filter((line) => lineComplete(grid, drawnSet, line));
  const rowColCount = completedRows.length + completedCols.length;
  const hasCorners = lineComplete(grid, drawnSet, CORNERS);
  const hasDiag = completedDiags.length > 0;
  const hasRowOrCol = rowColCount > 0;

  // Full card check
  let fullCard = true;
  const allCells = [];
  for (let r = 0; r < 5 && fullCard; r++) {
    for (let c = 0; c < 5; c++) {
      allCells.push([r, c]);
      if (!cellMatched(grid, r, c, drawnSet)) fullCard = false;
    }
  }

  const candidates = [];

  for (const rule of activeRules) {
    const mult = Number(rule.multiplier) || 0;
    if (mult <= 0) continue;
    const type = rule.type || rule.id;

    if (type === 'row_col_count' || type === 'one_line' || type === 'two_lines') {
      const minL = Number(rule.minLines != null ? rule.minLines : (type === 'two_lines' ? 2 : 1));
      const maxL = Number(rule.maxLines != null ? rule.maxLines : (type === 'one_line' ? 1 : 99));
      if (rowColCount >= minL && rowColCount <= maxL) {
        const take = Math.min(rowColCount, Math.max(minL, 2));
        const lines = completedRows.concat(completedCols).slice(0, take);
        const cells = [];
        lines.forEach((line) => line.forEach((p) => cells.push(p)));
        candidates.push({
          pattern: rule.id || type,
          label: rule.label,
          multiplier: mult,
          winningCells: uniqueCells(cells),
        });
      }
    } else if (type === 'diagonal') {
      if (hasDiag) {
        candidates.push({
          pattern: rule.id || 'diagonal',
          label: rule.label,
          multiplier: mult,
          winningCells: uniqueCells(completedDiags[0]),
        });
      }
    } else if (type === 'both_diagonals') {
      if (completedDiags.length >= 2) {
        candidates.push({
          pattern: rule.id || 'both_diagonals',
          label: rule.label,
          multiplier: mult,
          winningCells: uniqueCells(completedDiags[0].concat(completedDiags[1])),
        });
      }
    } else if (type === 'corners' || type === 'four_corners') {
      if (hasCorners) {
        candidates.push({
          pattern: rule.id || 'four_corners',
          label: rule.label,
          multiplier: mult,
          winningCells: CORNERS.map(([r, c]) => [r, c]),
        });
      }
    } else if (type === 'corners_plus_line') {
      if (hasCorners && (hasRowOrCol || hasDiag)) {
        const extra = hasRowOrCol ? (completedRows[0] || completedCols[0]) : completedDiags[0];
        candidates.push({
          pattern: rule.id || 'corners_plus_line',
          label: rule.label,
          multiplier: mult,
          winningCells: uniqueCells(CORNERS.concat(extra || [])),
        });
      }
    } else if (type === 'full_card') {
      if (fullCard) {
        candidates.push({
          pattern: rule.id || 'full_card',
          label: rule.label,
          multiplier: mult,
          winningCells: allCells,
        });
      }
    }
  }

  if (!candidates.length) {
    return { hit: false, pattern: null, multiplier: 0, winningCells: [], label: null };
  }

  candidates.sort((a, b) => b.multiplier - a.multiplier);
  const best = candidates[0];
  return {
    hit: true,
    pattern: best.pattern,
    label: best.label || best.pattern,
    multiplier: best.multiplier,
    winningCells: best.winningCells,
  };
}

function drawNumbers(count, max = 75) {
  const bag = [];
  for (let n = 1; n <= max; n++) bag.push(n);
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag.slice(0, count);
}

function normalizeWinRules(input) {
  const catalogById = {};
  PATTERN_CATALOG.forEach((p) => { catalogById[p.id] = p; });
  if (!Array.isArray(input)) return defaultWinRules();
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    if (!raw || !raw.id) continue;
    const cat = catalogById[raw.id] || catalogById[raw.type];
    if (!cat && !raw.type) continue;
    const type = raw.type || (cat && cat.type) || raw.id;
    const id = String(raw.id);
    if (seen.has(id)) continue;
    seen.add(id);
    const mult = Number(raw.multiplier);
    out.push({
      id,
      type,
      label: raw.label || (cat && cat.label) || id,
      description: raw.description || (cat && cat.description) || '',
      enabled: raw.enabled !== false,
      multiplier: Number.isFinite(mult) && mult > 0 ? mult : (cat ? cat.defaultMultiplier : 1),
      minLines: raw.minLines != null ? Number(raw.minLines) : cat && cat.minLines,
      maxLines: raw.maxLines != null ? Number(raw.maxLines) : cat && cat.maxLines,
    });
  }
  return out.length ? out : defaultWinRules();
}

module.exports = {
  LINES,
  ROWS,
  COLS,
  DIAGONALS,
  CORNERS,
  PATTERN_CATALOG,
  defaultWinRules,
  normalizeWinRules,
  evaluateCard,
  drawNumbers,
  cellMatched,
};
