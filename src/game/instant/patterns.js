'use strict';

/** Rows, columns, both main diagonals — “any one line” */
const LINES = [
  // rows
  [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]],
  [[1, 0], [1, 1], [1, 2], [1, 3], [1, 4]],
  [[2, 0], [2, 1], [2, 2], [2, 3], [2, 4]],
  [[3, 0], [3, 1], [3, 2], [3, 3], [3, 4]],
  [[4, 0], [4, 1], [4, 2], [4, 3], [4, 4]],
  // columns
  [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]],
  [[0, 1], [1, 1], [2, 1], [3, 1], [4, 1]],
  [[0, 2], [1, 2], [2, 2], [3, 2], [4, 2]],
  [[0, 3], [1, 3], [2, 3], [3, 3], [4, 3]],
  [[0, 4], [1, 4], [2, 4], [3, 4], [4, 4]],
  // diagonals
  [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4]],
  [[0, 4], [1, 3], [2, 2], [3, 1], [4, 0]],
];

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
 * Evaluate one card against a set of drawn numbers.
 * Returns best pattern: corners (2.5x) beats any single line (2x).
 */
function evaluateCard(grid, drawnNumbers, lineMultiplier, cornersMultiplier) {
  const drawnSet = new Set((drawnNumbers || []).map(Number));
  if (!Array.isArray(grid) || grid.length < 5) {
    return { hit: false, pattern: null, multiplier: 0, winningCells: [] };
  }

  if (lineComplete(grid, drawnSet, CORNERS)) {
    return {
      hit: true,
      pattern: 'four_corners',
      multiplier: cornersMultiplier,
      winningCells: CORNERS.map(([r, c]) => [r, c]),
    };
  }

  for (const line of LINES) {
    if (lineComplete(grid, drawnSet, line)) {
      return {
        hit: true,
        pattern: 'any_one_line',
        multiplier: lineMultiplier,
        winningCells: line.map(([r, c]) => [r, c]),
      };
    }
  }

  return { hit: false, pattern: null, multiplier: 0, winningCells: [] };
}

function drawNumbers(count, max = 75) {
  const bag = [];
  for (let n = 1; n <= max; n++) bag.push(n);
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [bag[i], bag[j]] = [bag[j], bag[i]];
  }
  return bag.slice(0, count).sort((a, b) => a - b);
}

module.exports = {
  LINES,
  CORNERS,
  evaluateCard,
  drawNumbers,
  cellMatched,
};
