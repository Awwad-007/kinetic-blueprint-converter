/* ═══════════════════════════════════════════════════════════════
   src/db/seeder.js
   Seeds all KINETIC PostgreSQL tables from the converted JSON.
   Uses a single transaction so it's fully atomic — either
   everything commits or nothing does.

   Tables seeded (in FK-safe order):
     buildings → floors → rooms → hazard_zones → cameras → doors
═══════════════════════════════════════════════════════════════ */

'use strict';

const { Pool } = require('pg');

/* ─── Connection pool ─────────────────────────────────────────── */
let pool;
function getPool() {
  if (!pool) {
    pool = new Pool({
      host:     process.env.PG_HOST     || 'localhost',
      port:     parseInt(process.env.PG_PORT) || 5432,
      database: process.env.PG_DATABASE || 'kinetic',
      user:     process.env.PG_USER     || 'postgres',
      password: process.env.PG_PASSWORD || '',
      max:      5,
      idleTimeoutMillis: 30000,
    });
    pool.on('error', (err) => {
      console.error('[DB POOL ERROR]', err.message);
    });
  }
  return pool;
}

/* ═══════════════════════════════════════════════════════════════
   seed(kineticJson, buildingMeta) → Promise<SeedResult>
═══════════════════════════════════════════════════════════════ */
async function seed(kineticJson, buildingMeta) {
  const client = await getPool().connect();

  const result = {
    buildingId:     null,
    floorsInserted: 0,
    roomsInserted:  0,
    doorsInserted:  0,
    hazardsInserted: 0,
    errors:         [],
  };

  try {
    await client.query('BEGIN');

    /* ── 1: Insert building ── */
    const bRes = await client.query(
      `INSERT INTO buildings (name, address, floor_count, total_capacity, timezone, is_active)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        buildingMeta.name     || 'Imported Building',
        buildingMeta.address  || '',
        buildingMeta.floorCount || Object.keys(kineticJson.floors).length,
        buildingMeta.capacity || 5000,
        buildingMeta.timezone || 'UTC',
      ]
    );

    const buildingId = bRes.rows[0]?.id;
    if (!buildingId) throw new Error('Could not insert building. Duplicate name?');
    result.buildingId = buildingId;

    /* ── 2: Insert floors + their children ── */
    for (const [floorNum, floorData] of Object.entries(kineticJson.floors)) {
      const fn = parseInt(floorNum);

      /* Floor row */
      const fRes = await client.query(
        `INSERT INTO floors (building_id, floor_number, label, capacity, is_restricted)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (building_id, floor_number) DO UPDATE
           SET label = EXCLUDED.label
         RETURNING id`,
        [
          buildingId,
          fn,
          floorData.name || `FLOOR ${fn}`,
          floorData.capacity || 500,
          false,
        ]
      );
      const floorId = fRes.rows[0]?.id;
      result.floorsInserted++;

      /* ── 3: Rooms ── */
      for (const room of (floorData.rooms || [])) {
        try {
          await client.query(
            `INSERT INTO rooms
               (floor_id, room_code, label, room_type, pos_x, pos_y, width, height,
                capacity, is_hazard)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (floor_id, room_code) DO UPDATE
               SET label = EXCLUDED.label`,
            [
              floorId,
              room.id.slice(0, 32),
              room.label.slice(0, 128),
              sanitizeRoomType(room.roomType),
              room.x,
              room.y,
              room.w,
              room.h,
              room.capacity || 50,
              room.isHazard || false,
            ]
          );
          result.roomsInserted++;
        } catch (e) {
          result.errors.push(`Room ${room.id}: ${e.message}`);
        }
      }

      /* ── 4: Doors ── */
      for (const door of (floorData.doors || [])) {
        try {
          await client.query(
            `INSERT INTO doors
               (building_id, door_code, floor_number, zone_label,
                pos_x, pos_y, orientation, is_locked, is_override, access_level)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             ON CONFLICT (door_code) DO UPDATE
               SET is_locked  = EXCLUDED.is_locked,
                   floor_number = EXCLUDED.floor_number`,
            [
              buildingId,
              door.id.slice(0, 16),
              fn,
              door.zoneLabel || `F${fn} Door`,
              door.x,
              door.y,
              door.horiz ? 'horizontal' : 'vertical',
              door.locked,
              door.override || false,
              fn,               // higher floors = higher access level
            ]
          );
          result.doorsInserted++;
        } catch (e) {
          result.errors.push(`Door ${door.id}: ${e.message}`);
        }
      }

      /* ── 5: Hazard Zones ── */
      for (const hz of (floorData.hazards || [])) {
        try {
          await client.query(
            `INSERT INTO hazard_zones
               (building_id, floor_number, zone_label, pos_x, pos_y,
                width, height, severity, is_active)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,TRUE)`,
            [
              buildingId,
              fn,
              (hz.label || 'HAZARD').slice(0, 128),
              hz.x,
              hz.y,
              hz.w,
              hz.h,
              hz.severity || 'red',
            ]
          );
          result.hazardsInserted++;
        } catch (e) {
          result.errors.push(`Hazard ${hz.label}: ${e.message}`);
        }
      }
    }

    /* ── 6: Log the import event ── */
    await client.query(
      `INSERT INTO incident_log
         (building_id, severity, event_type, message, metadata)
       VALUES ($1, 'green', 'BLUEPRINT_IMPORT', $2, $3)`,
      [
        result.buildingId,
        `Blueprint imported via KINETIC Converter — ${Object.keys(kineticJson.floors).length} floor(s)`,
        JSON.stringify({
          rooms:   result.roomsInserted,
          doors:   result.doorsInserted,
          hazards: result.hazardsInserted,
          errors:  result.errors.length,
        }),
      ]
    );

    await client.query('COMMIT');
    return result;

  } catch (err) {
    await client.query('ROLLBACK');
    throw new Error(`Database seed failed (rolled back): ${err.message}`);
  } finally {
    client.release();
  }
}

/* ─── Ensure room type is one of the DB enum values ─────────── */
const VALID_ROOM_TYPES = new Set([
  'lobby','suite','corridor','pantry','stairwell','elevator',
  'server','spa','hazard','exit','general','bathroom','storage','dining','terrace',
]);

function sanitizeRoomType(t) {
  return VALID_ROOM_TYPES.has(t) ? t : 'general';
}

module.exports = { seed };