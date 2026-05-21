/* ═══════════════════════════════════════════════════════════════
   src/normalizer.js
   Transforms raw parsed geometry (absolute CAD coordinates,
   typically in mm or feet) into a 0.0 → 1.0 normalised space
   that KINETIC's canvas rendering loop expects.

   Uses mathjs for:
   - Bounding-box computation
   - Uniform-scale affine transformation (preserves aspect ratio)
   - Coordinate matrix operations
═══════════════════════════════════════════════════════════════ */

'use strict';

const math = require('mathjs');

/* ── Padding inside the 0–1 space (so entities don't sit on edge) */
const PAD = 0.02;

/**
 * Normalise a single floor's geometry to 0.0–1.0 coordinate space.
 *
 * @param {FloorData} floorData  - Raw geometry from parser
 * @returns {{ normalized: FloorData, bounds: BoundingBox }}
 */
function normalize(floorData) {
  const bounds = computeBounds(floorData);

  if (!bounds) {
    // Empty floor — return as-is with unit bounds
    return {
      normalized: floorData,
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1, rangeX: 1, rangeY: 1, scale: 1 },
    };
  }

  const { minX, minY, rangeX, rangeY } = bounds;
  // Uniform scale: use the larger dimension so aspect ratio is preserved
  const scale = math.max(rangeX, rangeY) || 1;

  /**
   * Build a mathjs transformation matrix:
   *   1. Translate origin to (minX, minY)
   *   2. Scale by 1/scale
   *   3. Apply padding: output = pad + normalised * (1 - 2*pad)
   */
  const translateM = math.matrix([
    [1, 0, -minX],
    [0, 1, -minY],
    [0, 0, 1],
  ]);

  const scaleM = math.matrix([
    [1 / scale, 0, 0],
    [0,         1 / scale, 0],
    [0,         0, 1],
  ]);

  const padM = math.matrix([
    [1 - 2 * PAD, 0, PAD],
    [0,           1 - 2 * PAD, PAD],
    [0,           0, 1],
  ]);

  const T = math.multiply(padM, math.multiply(scaleM, translateM));

  /** Apply the transformation matrix to a single (x, y) point */
  function tx(x, y) {
    const pt = math.multiply(T, math.matrix([[x], [y], [1]]));
    return {
      x: Math.max(0, Math.min(1, +pt.get([0, 0]).toFixed(6))),
      y: Math.max(0, Math.min(1, +pt.get([1, 0]).toFixed(6))),
    };
  }

  /** Transform a width/height value (scalar, no offset) */
  function tw(val) {
    return Math.max(0, Math.min(1, +((val / scale) * (1 - 2 * PAD)).toFixed(6)));
  }

  /* ── Transform each geometry class ── */
  const normalized = {
    walls:   normalizeWalls  (floorData.walls   || [], tx),
    rooms:   normalizeRooms  (floorData.rooms   || [], tx, tw),
    doors:   normalizeDoors  (floorData.doors   || [], tx),
    exits:   normalizePoints (floorData.exits   || [], tx),
    hazards: normalizeHazards(floorData.hazards || [], tx, tw),
    labels:  normalizeLabels (floorData.labels  || [], tx),
  };

  /* Attach derived metadata useful for the KINETIC JSON */
  normalized._stats = {
    physicalRangeX_mm: rangeX,
    physicalRangeY_mm: rangeY,
    aspectRatio:       +(rangeX / (rangeY || 1)).toFixed(3),
    uniformScale:      +scale.toFixed(2),
  };

  return { normalized, bounds };
}

/* ─── Compute bounding box over ALL geometry in the floor ─────── */
function computeBounds(floorData) {
  const xs = [], ys = [];

  const addPt  = (x, y) => { xs.push(x); ys.push(y); };
  const addRect = (x, y, w, h) => { addPt(x, y); addPt(x + w, y + h); };

  for (const w of (floorData.walls  || [])) {
    if (w.isCircle) { addPt(w.cx - w.r, w.cy - w.r); addPt(w.cx + w.r, w.cy + w.r); }
    else            { addPt(w.x1, w.y1); addPt(w.x2, w.y2); }
  }
  for (const r of (floorData.rooms   || [])) addRect(r.x, r.y, r.w, r.h);
  for (const d of (floorData.doors   || [])) addPt(d.x, d.y);
  for (const e of (floorData.exits   || [])) addPt(e.x, e.y);
  for (const h of (floorData.hazards || [])) addRect(h.x, h.y, h.w, h.h);
  for (const l of (floorData.labels  || [])) addPt(l.x, l.y);

  if (!xs.length) return null;

  const minX = math.min(xs), maxX = math.max(xs);
  const minY = math.min(ys), maxY = math.max(ys);

  return {
    minX, minY, maxX, maxY,
    rangeX: maxX - minX || 1,
    rangeY: maxY - minY || 1,
  };
}

/* ─── Per-geometry normalisers ────────────────────────────────── */

function normalizeWalls(walls, tx) {
  return walls.map(w => {
    if (w.isCircle) {
      const c = tx(w.cx, w.cy);
      return { ...w, cx: c.x, cy: c.y, r: 0 };   // radius needs separate scaling — omit for now
    }
    const p1 = tx(w.x1, w.y1);
    const p2 = tx(w.x2, w.y2);
    return { ...w, x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
  });
}

function normalizeRooms(rooms, tx, tw) {
  return rooms.map(r => {
    const origin = tx(r.x, r.y);
    return {
      ...r,
      x: origin.x,
      y: origin.y,
      w: tw(r.w),
      h: tw(r.h),
    };
  });
}

function normalizeDoors(doors, tx) {
  return doors.map(d => {
    const pos = tx(d.x, d.y);
    return { ...d, x: pos.x, y: pos.y };
  });
}

function normalizePoints(points, tx) {
  return points.map(p => {
    const pos = tx(p.x, p.y);
    return { ...p, x: pos.x, y: pos.y };
  });
}

function normalizeHazards(hazards, tx, tw) {
  return hazards.map(h => {
    const origin = tx(h.x, h.y);
    return {
      ...h,
      x: origin.x,
      y: origin.y,
      w: tw(h.w),
      h: tw(h.h),
    };
  });
}

function normalizeLabels(labels, tx) {
  return labels.map(l => {
    const pos = tx(l.x, l.y);
    return { ...l, x: pos.x, y: pos.y };
  });
}

module.exports = normalize;