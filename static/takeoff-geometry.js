"use strict";

// Drawing coordinates always remain in original PDF user space. Zoom, rotation,
// crop offsets and device-pixel ratios are presentation concerns only.
((root) => {
  const point = (value) => Array.isArray(value) && value.length === 2 && value.every(Number.isFinite);
  function transform(p, matrix) {
    if (!point(p) || !Array.isArray(matrix) || matrix.length !== 6 || !matrix.every(Number.isFinite)) throw new Error("Invalid drawing coordinates.");
    return [matrix[0] * p[0] + matrix[2] * p[1] + matrix[4], matrix[1] * p[0] + matrix[3] * p[1] + matrix[5]];
  }
  function inverse(p, matrix) {
    const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
    if (!Number.isFinite(determinant) || determinant === 0) throw new Error("The page transform is not invertible.");
    return transform([p[0] - matrix[4], p[1] - matrix[5]], [matrix[3] / determinant, -matrix[1] / determinant, -matrix[2] / determinant, matrix[0] / determinant, 0, 0]);
  }
  function length(points) {
    if (!Array.isArray(points) || points.length < 2 || !points.every(point)) throw new Error("Trace at least two valid points.");
    return points.slice(1).reduce((total, p, i) => total + Math.hypot(p[0] - points[i][0], p[1] - points[i][1]), 0);
  }
  function bounds(points) {
    if (!points?.length || !points.every(point)) throw new Error("The source location is missing.");
    const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  function split(points, fraction = 0.5) {
    if (!(fraction > 0 && fraction < 1)) throw new Error("Split position must be inside the traced length.");
    const target = length(points) * fraction;
    if (!target) throw new Error("A zero-length trace cannot be split.");
    let traversed = 0;
    for (let i = 1; i < points.length; i++) {
      const before = points[i - 1], after = points[i], segment = Math.hypot(after[0] - before[0], after[1] - before[1]);
      if (segment && traversed + segment >= target) {
        const part = (target - traversed) / segment;
        const cut = [before[0] + (after[0] - before[0]) * part, before[1] + (after[1] - before[1]) * part];
        const left = [...points.slice(0, i), cut], right = [cut, ...points.slice(i)];
        if (part === 1) right.splice(1, 1);
        return [left, right];
      }
      traversed += segment;
    }
    throw new Error("The trace cannot be split here.");
  }
  function region(a, b) { const box = bounds([a, b]); return [box[0], box[1], box[2] - box[0], box[3] - box[1]]; }
  const api = { transform, inverse, length, bounds, split, region };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CeasefireTakeoffGeometry = api;
})(globalThis);
