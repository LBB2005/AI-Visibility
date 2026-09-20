/** Display helpers shared by the server report and the UI. */

export const pct = (x: number | null | undefined, digits = 0) => (x == null ? "—" : `${(x * 100).toFixed(digits)}%`);

/** Signed percentage points, e.g. "+12 pts" / "−3 pts" / "±0 pts". */
export const pts = (x: number | null | undefined, digits = 0) => {
  if (x == null) return "—";
  const v = x * 100;
  const sign = v > 0 ? "+" : v < 0 ? "−" : "±";
  return `${sign}${Math.abs(v).toFixed(digits)} pts`;
};
