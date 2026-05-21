/* ═══════════════════════════════════════════════════════════════
   src/exporters/kinetic.js
   Concurrent output pipeline for the "Export to KINETIC" button.

   Pipeline (two tasks run in parallel after JSON is built):
     Task A → Write JSON asset file into the KINETIC project dir
     Task B → Seed all PostgreSQL tables via pg pool

   The JSON structure produced matches the floorPlans object that
   KINETIC's script.js reads via buildFloorPlans().
═══════════════════════════════════════════════════════════════ */

'use strict';

const fs   = require('fs');
const path = require('path');
const { v4: uuid } = require('uuid');
const seeder = require('../db/seeder');

/* ─── Canonical room type classifier ─────────────────────────── */
const ROOM_TYPE_MAP = [
  { patterns: [/lobby|reception|entrance|foyer/i], type: 'lobby'      },
  { patterns: [/suite|room|guest|bedroom/i],       type: 'suite'      },
  { patterns: [/corridor|hall|passage|walkway/i],  type: 'corridor'   },
  { patterns: [/pantry|kitchen|cafeteria/i],       type: 'pantry'     },
  { patterns: [/stair|step|landing/i],             type: 'stairwell'  },
  { patterns: [/lift|elevator/i],                  type: 'elevator'   },
  { patterns: [/server|data|it room|comms/i],      type: 'server'     },
  { patterns: [/spa|wellness|pool|gym|fitness/i],  type: 'spa'        },
  { patterns: [/dining|restaurant|bar/i],          type: 'dining'     },
  { patterns: [/terrace|garden|balcony/i],         type: 'terrace'    },
  { patterns: [/hazard|danger|mechanical|mep/i],   type: 'hazard'     },
  { patterns: [/exit|egress|fire/i],               type: 'exit'       },
  { patterns: [/toilet|wc|bathroom|restroom/i],    type: 'bathroom'   },
  { patterns: [/store|storage|warehouse/i],        type: 'storage'    },
];

function classifyRoomType(label) {
  for (const { patterns, type } of ROOM_TYPE_MAP) {
    if (patterns.some(p => p.test(label))) return type;
  }
  return 'general';
}

/* ─── Choose accent colour by room type ──────────────────────── */
const TYPE_COLORS = {
  lobby:      { color: '#0a1f12', accent: '#00b82e' },
  suite:      { color: '#0d1a1a', accent: '#00c8ff' },
  corridor:   { color: '#060e09', accent: '#004d13' },
  pantry:     { color: '#150e08', accent: '#ff9500' },
  stairwell:  { color: '#0a0a08', accent: '#ff9500', isStair: true, isExit: true },
  elevator:   { color: '#0d0a00', accent: '#ff9500', isElev:  true  },
  server:     { color: '#0a0f0a', accent: '#00c8ff', restricted: true },
  spa:        { color: '#0d1a18', accent: '#00c8ff' },
  dining:     { color: '#150e08', accent: '#ff9500' },
  terrace:    { color: '#080d10', accent: '#00c8ff' },
  hazard:     { color: '#1a0505', accent: '#ff003c', isHazard: true, restricted: true },
  exit:       { color: '#0a1a10', accent: '#00ff41', isExit:   true  },
  bathroom:   { color: '#0a0f0f', accent: '#00c8ff' },
  storage:    { color: '#0a0a08', accent: '#ff9500' },
  general:    { color: '#0a0f0d', accent: '#4a7a58' },
};

/* ═══════════════════════════════════════════════════════════════
   buildJSON
   Converts normalised floor data into the KINETIC runtime format.
═══════════════════════════════════════════════════════════════ */
function buildJSON(normalizedFloors, buildingMeta, bounds) {
  const buildingId = uuid();
  const floors     = {};

  for (const [floorNum, floorData] of Object.entries(normalizedFloors)) {
    const fn = parseInt(floorNum);

    /* ── Rooms ── */
    const rooms = (floorData.rooms || []).map(r => {
      const roomType = classifyRoomType(r.label);
      const colors   = TYPE_COLORS[roomType] || TYPE_COLORS.general;
      return {
        id:         r.id   || `room-f${fn}-${uuid().slice(0,6)}`,
        label:      r.label || 'ROOM',
        x:          r.x,
        y:          r.y,
        w:          r.w,
        h:          r.h,
        roomType,
        ...colors,
      };
    });

    /* ── Doors ── */
    const doors = (floorData.doors || []).map(d => ({
      id:       d.id       || `D-${uuid().slice(0,4).toUpperCase()}`,
      x:        d.x,
      y:        d.y,
      horiz:    d.horiz !== undefined ? d.horiz : true,
      locked:   d.locked   ?? true,
      override: d.override ?? false,
      floor:    fn,
    }));

    /* ── Exit Points ── */
    const exits = (floorData.exits || []).map(e => ({
      x:     e.x,
      y:     e.y,
      label: e.label || 'EXIT',
      floor: fn,
    }));

    /* ── Hazard Zones ── */
    const hazards = (floorData.hazards || []).map(h => ({
      x:         h.x,
      y:         h.y,
      w:         h.w,
      h:         h.h,
      label:     h.label    || 'HAZARD ZONE',
      severity:  h.severity || 'red',
      floor:     fn,
    }));

    /* ── Wall Segments ── */
    const walls = (floorData.walls || []).map(w => ({
      x1: w.x1, y1: w.y1,
      x2: w.x2, y2: w.y2,
    }));

    floors[fn] = {
      floorNumber: fn,
      name:        `FLOOR ${fn}`,
      rooms,
      doors,
      exits,
      hazards,
      walls,
      stats:       floorData._stats || {},
    };
  }

  return {
    buildingId,
    building: buildingMeta,
    exportedAt: new Date().toISOString(),
    version:    '1.0',
    floors,
  };
}

/* ═══════════════════════════════════════════════════════════════
   writeAssetFile
   Writes the JSON into KINETIC's client/assets/floorplans/ dir.
═══════════════════════════════════════════════════════════════ */
function writeAssetFile(kineticJson, buildingName, sessionId) {
  const projectRoot = process.env.KINETIC_PROJECT_ROOT
    ? path.resolve(process.env.KINETIC_PROJECT_ROOT)
    : path.resolve(__dirname, '../../../');

  const assetDir = path.join(
    projectRoot,
    process.env.KINETIC_ASSET_PATH || 'client/assets/floorplans'
  );

  fs.mkdirSync(assetDir, { recursive: true });

  const safeName  = buildingName.replace(/[^a-z0-9_\-]/gi, '_').toLowerCase();
  const filename  = `floorplan-${safeName}-${sessionId.slice(0, 8)}.json`;
  const outPath   = path.join(assetDir, filename);

  fs.writeFileSync(outPath, JSON.stringify(kineticJson, null, 2), 'utf8');
  return outPath;
}

/* ═══════════════════════════════════════════════════════════════
   seedDatabase
   Inserts building → floors → rooms → doors → hazard_zones
   into PostgreSQL using the seeder module.
   Returns a summary of what was inserted.
═══════════════════════════════════════════════════════════════ */
async function seedDatabase(kineticJson, buildingMeta) {
  return seeder.seed(kineticJson, buildingMeta);
}

module.exports = { buildJSON, writeAssetFile, seedDatabase };