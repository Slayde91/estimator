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
  function enclosed(points, rectangle) {
    const box = bounds(points);
    return box[0] >= rectangle[0] && box[1] >= rectangle[1] && box[2] <= rectangle[2] && box[3] <= rectangle[3];
  }
  function translateGeometry(geometry, delta) {
    if (!point(delta) || !geometry?.points?.every(point)) throw new Error("Invalid markup movement.");
    const move = points => points.map(p => [p[0] + delta[0], p[1] + delta[1]]);
    return { ...geometry, points: move(geometry.points), ...(geometry.exclusions ? { exclusions: geometry.exclusions.map(value => ({ ...value, points: move(value.points) })) } : {}) };
  }
  function ring(points) {
    if (!Array.isArray(points) || points.length < 3 || points.length > 1000 || !points.every(point)) throw new Error("An area boundary needs 3–1,000 finite source-coordinate vertices.");
    const seen = new Set(points.map(p => JSON.stringify(p)));
    if (seen.size !== points.length) throw new Error("Each boundary vertex must be distinct. The boundary closes automatically; do not repeat its first vertex.");
    return points;
  }
  function polygonPath(geometry, matrix) {
    if (geometry?.kind !== "polygon" || !Array.isArray(geometry.exclusions)) throw new Error("The polygon boundary or exclusions are missing.");
    return [geometry.points, ...geometry.exclusions.map(exclusion => exclusion.points)].map(points => ring(points).map(p => transform(p, matrix)).map((p, i) => `${i ? "L" : "M"}${p[0]},${p[1]}`).join(" ") + " Z").join(" ");
  }
  function parseVertices(text) {
    const lines = String(text).trim().split(/\r?\n/);
    const points = lines.map(line => {
      const parts = line.trim().split(/[\s,]+/);
      if (parts.length !== 2 || parts.some(value => !value || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value))) throw new Error("Enter one source-coordinate pair per line, in the form x, y.");
      return parts.map(Number);
    });
    return ring(points);
  }
  // Display-only preview in source coordinates. Committed quantities and topology
  // are always supplied by the server. Shift the origin to avoid cancellation.
  function stableSum(values) {
    let sum = 0, correction = 0;
    for (const value of values) {
      const next = sum + value;
      correction += Math.abs(sum) >= Math.abs(value) ? (sum - next) + value : (value - next) + sum;
      sum = next;
    }
    return sum + correction;
  }
  function ringMetrics(points) {
    ring(points);
    const [ox, oy] = points[0], crosses = [], xs = [], ys = [];
    for (let i = 0; i < points.length; i++) {
      const next = points[(i + 1) % points.length], ax = points[i][0] - ox, ay = points[i][1] - oy, bx = next[0] - ox, by = next[1] - oy;
      const cross = ax * by - bx * ay; crosses.push(cross); xs.push((ax + bx) * cross); ys.push((ay + by) * cross);
    }
    const twiceArea = stableSum(crosses);
    if (!Number.isFinite(twiceArea) || !twiceArea) throw new Error("Complete a boundary with a positive area.");
    const centre = [ox + stableSum(xs) / (3 * twiceArea), oy + stableSum(ys) / (3 * twiceArea)];
    if (!point(centre)) throw new Error("The surface centre cannot be represented safely.");
    return { area: Math.abs(twiceArea) / 2, centre };
  }
  function ringLocation(position, points) {
    let inside = false;
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      const left = (b[0] - a[0]) * (position[1] - a[1]), right = (b[1] - a[1]) * (position[0] - a[0]);
      // Conservatively reject a numerically ambiguous boundary position rather
      // than placing a label in an opening or outside a very narrow surface.
      if (position[0] >= Math.min(a[0], b[0]) && position[0] <= Math.max(a[0], b[0]) &&
          position[1] >= Math.min(a[1], b[1]) && position[1] <= Math.max(a[1], b[1]) &&
          Math.abs(left - right) <= 8 * Number.EPSILON * (Math.abs(left) + Math.abs(right))) return 0;
      if ((a[1] > position[1]) !== (b[1] > position[1]) &&
          position[0] < a[0] + (position[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1])) inside = !inside;
    }
    return inside ? 1 : -1;
  }
  function surfaceMetrics(geometry) {
    const rings = [geometry.points, ...(geometry.exclusions || []).map(hole => hole.points)], outer = ringMetrics(rings[0]), holes = rings.slice(1).map(ringMetrics);
    const area = outer.area - stableSum(holes.map(hole => hole.area));
    if (!(area > 0) || !Number.isFinite(area)) throw new Error("Exclusions must leave a positive surface area.");
    const centre = [0, 1].map(axis => outer.centre[axis] + stableSum(holes.map(hole => (outer.centre[axis] - hole.centre[axis]) * hole.area)) / area);
    if (!point(centre)) throw new Error("The surface centre cannot be represented safely.");
    // Find a central interior span, so a concavity or excluded opening does not
    // swallow the label. Even/odd spans work for either boundary winding.
    const box = bounds(rings[0]); let label = null, best = Infinity;
    const scan = y => {
      const crossings = [];
      for (const points of rings) for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        if ((a[1] > y) !== (b[1] > y)) crossings.push(a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1]));
      }
      crossings.sort((a, b) => a - b);
      const candidates = [];
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        const left = crossings[i], right = crossings[i + 1]; if (!(right > left)) continue;
        const candidate = [centre[0] > left && centre[0] < right ? centre[0] : left + (right - left) / 2, y];
        if (candidate[0] > left && candidate[0] < right) candidates.push({ point: candidate, distance: Math.hypot(candidate[0] - centre[0], candidate[1] - centre[1]) });
      }
      candidates.sort((a, b) => a.distance - b.distance);
      // Bound strict interior probes on complex 1,000-vertex previews. The
      // fallback scanlines never coincide with a horizontal boundary.
      for (const candidate of candidates.slice(0, 8)) {
        if (candidate.distance >= best) break;
        if (ringLocation(candidate.point, rings[0]) !== 1 || rings.slice(1).some(hole => ringLocation(candidate.point, hole) !== -1)) continue;
        label = candidate.point; best = candidate.distance; break;
      }
    };
    for (const y of new Set([centre[1], box[1] + (box[3] - box[1]) / 2, outer.centre[1]])) scan(y);
    if (!label) {
      const levels = [...new Set(rings.flatMap(points => points.map(p => p[1])))].sort((a, b) => a - b), fallback = [];
      for (let i = 1; i < levels.length; i++) {
        const y = levels[i - 1] + (levels[i] - levels[i - 1]) / 2;
        if (y > levels[i - 1] && y < levels[i]) fallback.push(y);
      }
      fallback.sort((a, b) => Math.abs(a - centre[1]) - Math.abs(b - centre[1]));
      for (const y of fallback.slice(0, 16)) { scan(y); if (label) break; }
    }
    return { area, centre, label };
  }
  const api = { transform, inverse, length, bounds, split, region, enclosed, translateGeometry, ring, polygonPath, parseVertices, ringMetrics, surfaceMetrics };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CeasefireTakeoffGeometry = api;
})(globalThis);
