/* ═══════════════════════════════════════════════════════════════
   src/parsers/dxf.js
   Parses AutoCAD DXF files using the 'dxf-parser' npm package.

   Strategy:
   1. Read the raw DXF and call DxfParser().parseSync()
   2. Walk every entity and classify it by layer name using
      a configurable heuristic map.
   3. Group everything by floor (Z-elevation or layer prefix).
   4. Return the unified ParsedBuilding structure.
═══════════════════════════════════════════════════════════════ */

'use strict';

const fs        = require('fs');
const DxfParser = require('dxf-parser');

/* ─── Layer classification heuristics ───────────────────────────
   Engineers name layers differently per firm. These regex patterns
   cover the most common naming conventions (ArchiCAD, Revit export,
   AutoCAD AIA standard, and freeform).
─────────────────────────────────────────────────────────────── */
const LAYER_RULES = [
  { type: 'wall',    patterns: [/wall/i, /^a-wall/i, /^arch.*wall/i, /^wl/i, /partiti/i] },
  { type: 'room',    patterns: [/room/i, /space/i, /area/i, /^a-spac/i, /zone/i, /\bflr\b/i] },
  { type: 'door',    patterns: [/door/i, /^a-door/i, /opening/i, /entrn/i, /\bdr\b/i] },
  { type: 'window',  patterns: [/window/i, /^a-wind/i, /\bwin\b/i] },
  { type: 'stair',   patterns: [/stair/i, /step/i, /^a-strs/i, /\bst\b/i] },
  { type: 'exit',    patterns: [/exit/i, /egress/i, /evacu/i, /escape/i] },
  { type: 'hazard',  patterns: [/hazard/i, /danger/i, /restrict/i, /mechanical/i, /\bmep\b/i] },
  { type: 'column',  patterns: [/column/i, /^a-cols/i, /pillar/i, /\bcol\b/i] },
  { type: 'text',    patterns: [/text/i, /label/i, /anno/i, /^a-anno/i, /dimen/i] },
  { type: 'ceiling', patterns: [/ceil/i, /^a-clng/i] },
];

/* ─── Classify a layer name → semantic type ── */
function classifyLayer(layerName) {
  const name = (layerName || '').trim();
  for (const rule of LAYER_RULES) {
    for (const pat of rule.patterns) {
      if (pat.test(name)) return rule.type;
    }
  }
  return 'unknown';
}

/* ─── Extract floor number from layer name or entity elevation ── */
function extractFloor(entity, layerName) {
  // Prefer explicit Z elevation (common in multi-storey DXF)
  const z = entity.position?.z ?? entity.vertices?.[0]?.z ?? entity.start?.z ?? 0;
  if (z !== 0) {
    // Typical storey height: 3–4m. Map elevation → floor number.
    return Math.max(1, Math.round(z / 3500) + 1);  // assumes mm units
  }

  // Try to parse floor from layer name: e.g. "A-WALL-F2", "LEVEL_3", "FL01"
  const levelMatch =
       layerName.match(/[_\-\s]?F(\d+)/i)     // F1, F2
    || layerName.match(/[_\-\s]?L(?:VL|EVEL)?[_\-\s]?(\d+)/i)  // L1, LVL3, LEVEL-2
    || layerName.match(/[_\-\s]?(\d+)(?:ST|ND|RD|TH)?[_\-\s]?FL/i);  // 1ST FL, 2FL

  if (levelMatch) return parseInt(levelMatch[1]);

  return 1; // Default: ground floor
}

/* ─── Convert a LWPOLYLINE / POLYLINE vertex list to segments ── */
function polylineToSegments(vertices) {
  const segs = [];
  for (let i = 0; i < vertices.length - 1; i++) {
    segs.push({
      x1: vertices[i].x,   y1: vertices[i].y,
      x2: vertices[i+1].x, y2: vertices[i+1].y,
    });
  }
  // Close if it's a closed polyline
  if (vertices.length > 2) {
    const last  = vertices[vertices.length - 1];
    const first = vertices[0];
    segs.push({ x1: last.x, y1: last.y, x2: first.x, y2: first.y });
  }
  return segs;
}

/* ─── Build a bounding-box room object from a closed polyline ── */
function polylineToBBoxRoom(entity, layerName) {
  const verts = entity.vertices || [];
  if (verts.length < 3) return null;

  const xs = verts.map(v => v.x);
  const ys = verts.map(v => v.y);
  return {
    id:    `room-${entity.handle || Math.random().toString(36).slice(2)}`,
    label: entity.text || layerName,
    x:     Math.min(...xs),
    y:     Math.min(...ys),
    w:     Math.max(...xs) - Math.min(...xs),
    h:     Math.max(...ys) - Math.min(...ys),
    layer: layerName,
  };
}

/* ─── Build a door object from INSERT/BLOCK or LINE entity ────── */
function entityToDoor(entity, layerName) {
  const x = entity.position?.x ?? entity.start?.x ?? entity.center?.x ?? 0;
  const y = entity.position?.y ?? entity.start?.y ?? entity.center?.y ?? 0;
  const rotation = entity.rotation || 0;
  return {
    id:        entity.name || entity.handle || 'door-unknown',
    x,
    y,
    rotation,
    horiz:     rotation === 0 || rotation === 180,
    locked:    false,
    override:  false,
    layer:     layerName,
  };
}

/* ═══════════════════════════════════════════════════════════════
   MAIN DXF PARSER
═══════════════════════════════════════════════════════════════ */
async function parseDXF(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');

  const parser = new DxfParser();
  let dxf;
  try {
    dxf = parser.parseSync(raw);
  } catch (e) {
    throw new Error(`DXF parse error: ${e.message}`);
  }

  /* Initialise per-floor buckets */
  const floors = {};

  function getFloor(n) {
    if (!floors[n]) {
      floors[n] = { walls: [], rooms: [], doors: [], exits: [], hazards: [], labels: [] };
    }
    return floors[n];
  }

  let totalEntities = 0;

  /* Walk every entity in the ENTITIES section */
  for (const entity of (dxf.entities || [])) {
    totalEntities++;
    const layerName = entity.layer || '0';
    const semantic  = classifyLayer(layerName);
    const floorNum  = extractFloor(entity, layerName);
    const floor     = getFloor(floorNum);

    switch (entity.type) {

      /* ── Walls: LINE entities on wall layers ── */
      case 'LINE':
        if (semantic === 'wall') {
          floor.walls.push({
            x1: entity.start.x, y1: entity.start.y,
            x2: entity.end.x,   y2: entity.end.y,
            layer: layerName,
          });
        }
        if (semantic === 'door') floor.doors.push(entityToDoor(entity, layerName));
        if (semantic === 'exit') floor.exits.push({ x: entity.start.x, y: entity.start.y, label: 'EXIT', layer: layerName });
        break;

      /* ── Walls + room outlines: LWPOLYLINE ── */
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        const verts = entity.vertices || [];
        if (semantic === 'wall') {
          floor.walls.push(...polylineToSegments(verts));
        } else if (['room', 'space', 'area', 'unknown'].includes(semantic) && verts.length >= 3) {
          const room = polylineToBBoxRoom(entity, layerName);
          if (room) floor.rooms.push(room);
        } else if (semantic === 'hazard' && verts.length >= 3) {
          const bbox = polylineToBBoxRoom(entity, layerName);
          if (bbox) floor.hazards.push({ ...bbox, severity: 'red' });
        } else if (semantic === 'exit' && verts.length >= 2) {
          floor.exits.push({ x: verts[0].x, y: verts[0].y, label: 'EXIT', layer: layerName });
        }
        break;
      }

      /* ── Doors: INSERT (block references), often a door symbol ── */
      case 'INSERT':
        if (semantic === 'door' || /door|dr/i.test(entity.name || '')) {
          floor.doors.push(entityToDoor(entity, layerName));
        }
        if (semantic === 'stair' || /stair|strs/i.test(entity.name || '')) {
          floor.exits.push({
            x:     entity.position?.x || 0,
            y:     entity.position?.y || 0,
            label: 'STAIR',
            layer: layerName,
          });
        }
        break;

      /* ── Text / labels: TEXT and MTEXT ── */
      case 'TEXT':
      case 'MTEXT':
        floor.labels.push({
          x:    entity.startPoint?.x ?? entity.position?.x ?? 0,
          y:    entity.startPoint?.y ?? entity.position?.y ?? 0,
          text: entity.text || entity.string || '',
          layer: layerName,
        });
        break;

      /* ── Circles: sometimes used for columns / pillars ── */
      case 'CIRCLE':
        if (semantic === 'column') {
          floor.walls.push({
            isCircle: true,
            cx: entity.center.x, cy: entity.center.y, r: entity.radius,
            layer: layerName,
          });
        }
        break;

      /* ── ARC: curved walls or door swings ── */
      case 'ARC':
        if (semantic === 'door') {
          floor.doors.push({
            id:    entity.handle || 'arc-door',
            x:     entity.center.x,
            y:     entity.center.y,
            radius: entity.radius,
            isArc: true,
            startAngle: entity.startAngle,
            endAngle:   entity.endAngle,
            locked:    false,
            override:  false,
            layer:     layerName,
          });
        }
        break;

      default:
        break;
    }
  }

  /* ── If no rooms were extracted from geometry (e.g. all walls, no closed polys),
        attempt to synthesise rooms by detecting closed wall regions ── */
  for (const [floorNum, floorData] of Object.entries(floors)) {
    if (floorData.rooms.length === 0 && floorData.walls.length > 0) {
      floorData.rooms = synthesiseRoomsFromWalls(floorData.walls, floorData.labels);
    }
  }

  /* ── Attach text labels to nearest room ── */
  for (const floorData of Object.values(floors)) {
    attachLabelsToRooms(floorData);
  }

  /* Ensure at least floor 1 exists */
  if (Object.keys(floors).length === 0) {
    throw new Error('No geometry extracted from DXF. Check layer names or file structure.');
  }

  return { floors, totalEntities };
}

/* ─── Synthesise coarse room bboxes from wall segments ─────────
   Groups walls into X/Y extents and creates rough bounding boxes.
   This is a best-effort fallback when polylines weren't used.
─────────────────────────────────────────────────────────────── */
function synthesiseRoomsFromWalls(walls, labels) {
  if (!walls.length) return [];

  const allX = walls.flatMap(w => w.isCircle ? [w.cx - w.r, w.cx + w.r] : [w.x1, w.x2]);
  const allY = walls.flatMap(w => w.isCircle ? [w.cy - w.r, w.cy + w.r] : [w.y1, w.y2]);

  const globalMinX = Math.min(...allX);
  const globalMaxX = Math.max(...allX);
  const globalMinY = Math.min(...allY);
  const globalMaxY = Math.max(...allY);
  const totalW     = globalMaxX - globalMinX;
  const totalH     = globalMaxY - globalMinY;

  /* Split the bounding box into a 3×3 grid of likely rooms */
  const rooms = [];
  const cols = 3, rows = 3;
  const cW = totalW / cols, cH = totalH / rows;
  let idx = 0;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const nearLabel = labels.find(l => {
        return l.x >= globalMinX + c * cW && l.x < globalMinX + (c+1) * cW &&
               l.y >= globalMinY + r * cH && l.y < globalMinY + (r+1) * cH;
      });
      rooms.push({
        id:    `synth-room-${idx++}`,
        label: nearLabel?.text || `ROOM ${idx}`,
        x:     globalMinX + c * cW + 1,
        y:     globalMinY + r * cH + 1,
        w:     cW - 2,
        h:     cH - 2,
        layer: 'synthesised',
        isSynthesised: true,
      });
    }
  }

  return rooms;
}

/* ─── Attach text labels to nearest room ── */
function attachLabelsToRooms(floorData) {
  for (const lbl of floorData.labels) {
    let nearest = null;
    let minDist = Infinity;

    for (const room of floorData.rooms) {
      const cx = room.x + room.w / 2;
      const cy = room.y + room.h / 2;
      const d  = Math.hypot(lbl.x - cx, lbl.y - cy);
      if (d < minDist) { minDist = d; nearest = room; }
    }

    if (nearest && minDist < (nearest.w + nearest.h) / 2) {
      // Only override if the label seems more descriptive
      if (lbl.text.length > 1 && !lbl.text.match(/^\d+$/)) {
        nearest.label = lbl.text.trim().toUpperCase();
      }
    }
  }
}

module.exports = parseDXF;