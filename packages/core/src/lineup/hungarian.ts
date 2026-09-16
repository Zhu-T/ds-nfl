/**
 * Rectangular assignment problem, solved exactly.
 *
 * This is the Jonker-Volgenant / Hungarian shortest-augmenting-path algorithm
 * with dual potentials, O(n^2 * m). Lineups are tiny (~12 slots, ~20 players)
 * so this runs in microseconds and there is no reason to approximate.
 */

/**
 * Assign every row to a distinct column, minimising total cost.
 *
 * @param cost  Dense matrix, `cost[row][col]`. All entries must be finite.
 *              Requires `cols >= rows` — pad with zero-cost dummy columns if not.
 * @returns     `rowToCol[i]` = the column assigned to row `i`.
 */
export function hungarian(cost: readonly (readonly number[])[]): number[] {
  const n = cost.length;
  if (n === 0) return [];
  const m = cost[0]!.length;
  if (m < n) {
    throw new Error(`hungarian: needs cols >= rows, got ${m} cols for ${n} rows`);
  }

  // 1-indexed internally; index 0 is the algorithm's virtual starting column.
  const u = new Array<number>(n + 1).fill(0); // row potentials
  const v = new Array<number>(m + 1).fill(0); // column potentials
  const p = new Array<number>(m + 1).fill(0); // p[col] = row matched to col
  const way = new Array<number>(m + 1).fill(0); // augmenting path predecessor

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(m + 1).fill(Infinity);
    const used = new Array<boolean>(m + 1).fill(false);

    // Grow a shortest augmenting path from row i until it reaches a free column.
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = 0;

      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }

      // Re-weight so the path stays tight.
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[p[j]!] = u[p[j]!]! + delta;
          v[j] = v[j]! - delta;
        } else {
          minv[j] = minv[j]! - delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    // Walk the path back, flipping matched edges.
    do {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }

  const rowToCol = new Array<number>(n).fill(-1);
  for (let j = 1; j <= m; j++) {
    const row = p[j]!;
    if (row > 0) rowToCol[row - 1] = j - 1;
  }
  return rowToCol;
}
