/* ═══════════════════════════════════════════════════════════════
   src/parsers/ifc.js
   Parses IFC STEP-format files (.ifc) without requiring native
   binaries. IFC STEP is plain ASCII text — each line is an entity:
     #123 = IFCSPACE(...) ;
   We read the file line-by-line, build an entity table, then
   resolve the geometry we care about.

   Entities extracted:
     IfcBuildingStorey     → floor number + elevation
     IfcSpace              → rooms with bounding box
     IfcDoor               → door position + orientation
     IfcStairFlight        → stairwell location
     IfcZone               → hazard / restricted zones
     IfcRelContainedIn...  → spatial relationships
═══════════════════════════════════════════════════════════════ */

'use strict';

const fs   = require('fs');
const path = require('path');

/* ─── Regex to match a STEP entity line ───────────────────────── */
const ENTITY_RE = /^#(\d+)\s*=\s*([A-Z_]+)\s*\((.+)\)\s*;?\s*$/i;

/* ─── Parse a STEP attribute list into an array of raw strings ── */
function parseAttrs(raw) {
  const attrs = [];
  let depth = 0, current = '', i = 0;

  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '(') { depth++; current += ch; }
    else if (ch === ')') { depth--; current += ch; }
    else if (ch === ',' && depth === 0) {
      attrs.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
    i++;
  }
  if (current.trim()) attrs.push(current.trim());
  return attrs;
}

/* ─── Strip IFC string quoting  e.g. 'MAIN LOBBY' → MAIN LOBBY ── */
function stripStr(s) {
  return (s || '').replace(/^'/, '').replace(/'$/, '').trim();
}

/* ─── Resolve a #ref to an entity ID ── */
function refId(s) {
  const m = (s || '').match(/#(\d+)/);
  return m ? m[1] : null;
}

/* ─── Extract a 2-3D point from a raw STEP attribute string ────── */
function extractPoint(raw) {
  const m = raw.match(/\(\s*([-\d.E+]+)\s*,\s*([-\d.E+]+)(?:\s*,\s*([-\d.E+]+))?\s*\)/);
  if (!m) return null;
  return { x: parseFloat(m[1]), y: parseFloat(m[2]), z: m[3] ? parseFloat(m[3]) : 0 };
}

/* ═══════════════════════════════════════════════════════════════
   MAIN IFC PARSER
═══════════════════════════════════════════════════════════════ */
async function parseIFC(filePath) {
  const lines   = fs.readFileSync(filePath, 'utf8').split('\n');
  const table   = {};   // #id → { type, attrs, raw }

  /* ── Pass 1: Build entity table ── */
  let buffer = '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('/*') || trimmed === 'DATA;' || trimmed === 'ENDSEC;') continue;

    buffer += ' ' + trimmed;

    // A complete entity ends with ;
    if (buffer.trimEnd().endsWith(';')) {
      const m = buffer.trim().match(ENTITY_RE);
      if (m) {
        const id    = m[1];
        const type  = m[2].toUpperCase();
        const raw   = m[3];
        const attrs = parseAttrs(raw);
        table[id]   = { type, attrs, raw };
      }
      buffer = '';
    }
  }

  /* ── Pass 2: Find IfcBuildingStorey → map #id → floor number ── */
  const storeyFloorMap = {};  // #id → floor number
  let floorIndex = 1;

  const storeys = Object.entries(table)
    .filter(([, e]) => e.type === 'IFCBUILDINGSTOREY')
    .sort(([, a], [, b]) => {
      const elevA = parseFloat(a.attrs[9] || 0);
      const elevB = parseFloat(b.attrs[9] || 0);
      return elevA - elevB;
    });

  for (const [id] of storeys) {
    storeyFloorMap[id] = floorIndex++;
  }

  /* ── Pass 3: Resolve IfcRelContainedInSpatialStructure
                so we know which storey each element belongs to ── */
  const elementStorey = {};  // element #id → storey #id

  for (const [, entity] of Object.entries(table)) {
    if (entity.type !== 'IFCRELCONTAINEDINSPATIALSTRUCTURE') continue;
    // attrs[4] = RelatingStructure (#ref to storey)
    // attrs[3] = RelatedElements  (list of element #refs)
    const storeyRef = refId(entity.attrs[4]);
    if (!storeyRef) continue;

    const listRaw   = entity.attrs[3] || '';
    const members   = listRaw.replace(/[()]/g, '').split(',').map(s => refId(s.trim())).filter(Boolean);
    for (const memberId of members) {
      elementStorey[memberId] = storeyRef;
    }
  }

  /* ── Pass 4: Walk elements and build floor data ── */
  const floors = {};

  function getFloor(storeyId) {
    const fn = storeyFloorMap[storeyId] || 1;
    if (!floors[fn]) floors[fn] = { walls: [], rooms: [], doors: [], exits: [], hazards: [], labels: [] };
    return floors[fn];
  }

  for (const [id, entity] of Object.entries(table)) {
    const storeyId = elementStorey[id];
    if (!storeyId && !storeyFloorMap[id]) continue;  // skip unrelated entities

    /* ── IfcSpace → Room ── */
    if (entity.type === 'IFCSPACE') {
      const name = stripStr(entity.attrs[2]) || 'SPACE';
      const pt   = resolveLocation(table, entity.attrs[5]);

      if (pt) {
        const dims = resolveSpaceDims(table, id);
        const floor = getFloor(storeyId || Object.keys(storeyFloorMap)[0]);
        floor.rooms.push({
          id:    `ifc-space-${id}`,
          label: name.toUpperCase(),
          x:     pt.x,
          y:     pt.y,
          w:     dims.w,
          h:     dims.h,
          layer: 'IfcSpace',
        });
      }
    }

    /* ── IfcDoor → Door ── */
    if (entity.type === 'IFCDOOR') {
      const name = stripStr(entity.attrs[2]) || `DOOR-${id}`;
      const pt   = resolveLocation(table, entity.attrs[5]);
      if (pt) {
        const floor = getFloor(storeyId);
        floor.doors.push({
          id:       name,
          x:        pt.x,
          y:        pt.y,
          horiz:    true,
          locked:   false,
          override: false,
          layer:    'IfcDoor',
        });
      }
    }

    /* ── IfcStairFlight → Exit/Stair ── */
    if (entity.type === 'IFCSTAIRFLIGHT') {
      const pt = resolveLocation(table, entity.attrs[5]);
      if (pt) {
        const floor = getFloor(storeyId);
        floor.exits.push({ x: pt.x, y: pt.y, label: 'STAIR', layer: 'IfcStair' });
      }
    }

    /* ── IfcZone → Hazard zones (security zones, mechanical rooms) ── */
    if (entity.type === 'IFCZONE') {
      const name = stripStr(entity.attrs[2]) || 'ZONE';
      const pt   = resolveLocation(table, entity.attrs[5]);
      if (pt) {
        const floor = getFloor(storeyId);
        floor.hazards.push({
          id:       `ifc-zone-${id}`,
          label:    name.toUpperCase(),
          x:        pt.x, y: pt.y, w: 5000, h: 5000,  // fallback size in mm
          severity: /restrict|mech|elec|hazard/i.test(name) ? 'red' : 'amber',
          layer:    'IfcZone',
        });
      }
    }

    /* ── IfcOpeningElement → Exit openings ── */
    if (entity.type === 'IFCOPENINGELEMENT') {
      const name = stripStr(entity.attrs[2]) || '';
      if (/exit|egress|emergency/i.test(name)) {
        const pt = resolveLocation(table, entity.attrs[5]);
        if (pt) {
          const floor = getFloor(storeyId);
          floor.exits.push({ x: pt.x, y: pt.y, label: 'EXIT', layer: 'IfcOpening' });
        }
      }
    }
  }

  /* ── Fallback: if we got storeys but no rooms, synthesise from storey bboxes ── */
  for (const [floorNum, floorData] of Object.entries(floors)) {
    if (floorData.rooms.length === 0) {
      floorData.rooms = [{ id: `floor${floorNum}-area`, label: `FLOOR ${floorNum}`, x: 0, y: 0, w: 50000, h: 30000, layer: 'synthesised' }];
    }
  }

  if (Object.keys(floors).length === 0) {
    throw new Error('IFC parsing extracted 0 floors. Ensure the file contains IfcBuildingStorey entities.');
  }

  return { floors, totalEntities: Object.keys(table).length };
}

/* ─── Resolve an IfcLocalPlacement → { x, y, z } ─────────────── */
function resolveLocation(table, placementRef) {
  const placId = refId(placementRef);
  if (!placId) return null;

  const plac = table[placId];
  if (!plac) return null;

  if (plac.type === 'IFCLOCALPLACEMENT') {
    const axisRef = refId(plac.attrs[1]);
    if (!axisRef) return null;
    const axis = table[axisRef];
    if (!axis) return null;

    // IfcAxis2Placement3D  or  IfcAxis2Placement2D
    if (axis.type === 'IFCAXIS2PLACEMENT3D' || axis.type === 'IFCAXIS2PLACEMENT2D') {
      const locRef = refId(axis.attrs[0]);
      if (!locRef) return null;
      const locE = table[locRef];
      if (!locE) return null;
      return extractPoint(`(${locE.attrs.join(',')})`);
    }
  }

  if (plac.type === 'IFCCARTESIANPOINT') {
    return extractPoint(`(${plac.attrs.join(',')})`);
  }

  return null;
}

/* ─── Attempt to get approximate dimensions of an IfcSpace ─────── */
function resolveSpaceDims(table, spaceId) {
  // Look for IfcRelDefinesByProperties → IfcPropertySet → IfcPropertySingleValue
  // with names like "Area", "Width", "Length"
  const defaults = { w: 6000, h: 4000 };   // 6m × 4m in mm (common room)

  for (const [, entity] of Object.entries(table)) {
    if (entity.type !== 'IFCRELDEFINESBYPROPERTIES') continue;
    const objects = (entity.attrs[4] || '').replace(/[()]/g, '').split(',');
    if (!objects.some(o => refId(o) === spaceId)) continue;

    const propSetRef = refId(entity.attrs[5]);
    if (!propSetRef) continue;
    const propSet = table[propSetRef];
    if (!propSet || propSet.type !== 'IFCPROPERTYSET') continue;

    const propRefs = (propSet.attrs[4] || '').replace(/[()]/g, '').split(',').map(r => refId(r.trim())).filter(Boolean);
    let w = null, h = null;

    for (const pRef of propRefs) {
      const prop = table[pRef];
      if (!prop || prop.type !== 'IFCPROPERTYSINGLEVALUE') continue;
      const name = stripStr(prop.attrs[0]).toLowerCase();
      const val  = parseFloat(prop.attrs[2]?.replace(/[^0-9.E+-]/gi, '') || 0);

      if (/width|length|x/i.test(name) && !w) w = val;
      if (/depth|breadth|y/i.test(name)  && !h) h = val;
    }

    return { w: w || defaults.w, h: h || defaults.h };
  }

  return defaults;
}

module.exports = parseIFC;