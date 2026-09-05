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
/** Full lines list kept for any callers that still import LINES */
const LINES = ROWS.concat(COLS).concat(DIAGONALS);
const CORNERS = [[0, 0], [0, 4], [4, 0], [4, 4]];

function cellMatched(grid, r, c, drawnSet) {
  const v = grid[r][c];
  if (v === 'FREE' || v === 0 || (r === 2 && c === 2)) return true;
  return drawnSet.has(Number(v));
}

function lineComplete(grid, drawnSet, cells) {
  return cells.every(([r, c]) => cellMatched(grid, r, c, drawnSet));
}

/**
 * New Instant Bingo payout rules (best pattern wins):
 *  - 1 row OR 1 column          → 1×  (stake back)
 *  - 2+ rows/columns            → 2×  (capped; no 3-line tier)
 *  - 1 diagonal                 → 1.5×
 *  - 4 corners                  → 2.5×
 *  - 4 corners + (row|col|diag) → 4×
 */
function evaluateCard(grid, drawnNumbers) {
  const drawnSet = new Set((drawnNumbers || []).map(Number));
  if (!Array.isArray(grid) || grid.length < 5) {
    return { hit: false, pattern: null, multiplier: 0, winningCells: [] };
  }

  const completedRows = ROWS.filter((line) => lineComplete(grid, drawnSet, line));
  const completedCols = COLS.filter((line) => lineComplete(grid, drawnSet, line));
  const completedDiags = DIAGONALS.filter((line) => lineComplete(grid, drawnSet, line));
  const rowColCount = completedRows.length + completedCols.length;
  const hasCorners = lineComplete(grid, drawnSet, CORNERS);
  const hasDiag = completedDiags.length > 0;
  const hasRowOrCol = rowColCount > 0;

  const candidates = [];

  // 4× — corners + any line (row, column, or diagonal)
  if (hasCorners && (hasRowOrCol || hasDiag)) {
    const extra = hasRowOrCol
      ? (completedRows[0] || completedCols[0])
      : completedDiags[0];
    const cells = CORNERS.concat(extra || []);
    // unique cells
    const seen = new Set();
    const uniq = [];
    cells.forEach(([r, c]) => {
      const k = r + ',' + c;
      if (!seen.has(k)) { seen.add(k); uniq.push([r, c]); }
    });
    candidates.push({ pattern: 'corners_plus_line', multiplier: 4, winningCells: uniq });
  }

  if (hasCorners) {
    candidates.push({
      pattern: 'four_corners',
      multiplier: 2.5,
      winningCells: CORNERS.map(([r, c]) => [r, c]),
    });
  }

  if (hasDiag) {
    candidates.push({
      pattern: 'diagonal',
      multiplier: 1.5,
      winningCells: completedDiags[0].map(([r, c]) => [r, c]),
    });
  }

  if (rowColCount >= 2) {
    // Cap at two lines for payout; collect cells from first two completed
    const lines = completedRows.concat(completedCols).slice(0, 2);
    const cells = [];
    const seen = new Set();
    lines.forEach((line) => {
      line.forEach(([r, c]) => {
        const k = r + ',' + c;
        if (!seen.has(k)) { seen.add(k); cells.push([r, c]); }
      });
    });
    candidates.push({ pattern: 'two_lines', multiplier: 2, winningCells: cells });
  } else if (rowColCount === 1) {
    const line = completedRows[0] || completedCols[0];
    candidates.push({
      pattern: 'one_line',
      multiplier: 1,
      winningCells: line.map(([r, c]) => [r, c]),
    });
  }

  if (!candidates.length) {
    return { hit: false, pattern: null, multiplier: 0, winningCells: [] };
  }

  candidates.sort((a, b) => b.multiplier - a.multiplier);
  const best = candidates[0];
  return {
    hit: true,
    pattern: best.pattern,
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

module.exports = {
  LINES,
  ROWS,
  COLS,
  DIAGONALS,
  CORNERS,
  evaluateCard,
  drawNumbers,
  cellMatched,
};
