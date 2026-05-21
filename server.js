/* ═══════════════════════════════════════════════════════════════════
   KINETIC Blueprint Converter — server.js
   Standalone sub-project: parses DXF / IFC blueprints and exports
   either into the live KINETIC runtime or as a standalone SVG file.
═══════════════════════════════════════════════════════════════════ */

'use strict';

require('dotenv').config();

const express   = require('express');
const cors      = require('cors');
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');
const { v4: uuid } = require('uuid');
const chalk     = require('chalk');

const parseBlueprint   = require('./src/parsers/index');
const normalize        = require('./src/normalizer');
const kineticExporter  = require('./src/exporters/kinetic');
const svgExporter      = require('./src/exporters/svg');

/* ── App setup ────────────────────────────────────────────────── */
const app  = express();
const PORT = process.env.CONVERTER_PORT || 4000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ── Upload storage — keep files in /tmp, detect by extension ── */
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'tmp');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `upload-${uuid()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB) || 150) * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.dxf', '.ifc', '.dwg'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) return cb(null, true);
    cb(new Error(`Unsupported file type: ${ext}. Accepted: ${allowed.join(', ')}`));
  },
});

/* ── In-memory session state (one active parse per server session) */
let SESSION = {
  id:           null,
  rawFilePath:  null,
  fileType:     null,
  buildingMeta: {},
  parsedFloors: {},   // raw parsed geometry per floor, before normalization
  normalized:   {},   // 0.0–1.0 coordinate space per floor
  bounds:       {},   // { minX, minY, maxX, maxY } per floor
  log:          [],
};

function sessionLog(level, msg) {
  const entry = { level, msg, ts: new Date().toISOString() };
  SESSION.log.push(entry);
  const color = { info: 'cyan', ok: 'green', warn: 'yellow', error: 'red' }[level] || 'white';
  console.log(chalk[color](`[${level.toUpperCase()}] ${msg}`));
}

/* ═══════════════════════════════════════════════════════════════
   ROUTE: POST /api/upload
   Receives DXF/IFC file + building metadata.
   Runs parser → normalizer → stores result in SESSION.
═══════════════════════════════════════════════════════════════ */
app.post('/api/upload', upload.single('blueprint'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

    // Reset session
    SESSION = {
      id:           uuid(),
      rawFilePath:  req.file.path,
      fileType:     path.extname(req.file.originalname).toLowerCase().slice(1),
      buildingMeta: {
        name:       req.body.buildingName    || 'Unnamed Building',
        address:    req.body.buildingAddress || '',
        floorCount: parseInt(req.body.floorCount) || 1,
        timezone:   req.body.timezone        || 'UTC',
      },
      parsedFloors: {},
      normalized:   {},
      bounds:       {},
      log:          [],
    };

    sessionLog('info', `File received: ${req.file.originalname} (${req.file.size} bytes) → ${SESSION.fileType.toUpperCase()}`);

    /* Step 1 — Parse raw geometry from file */
    sessionLog('info', 'Starting geometry extraction…');
    const raw = await parseBlueprint(req.file.path, SESSION.fileType);
    SESSION.parsedFloors = raw.floors;
    sessionLog('ok',   `Parsed ${Object.keys(raw.floors).length} floor(s), ${raw.totalEntities} entities.`);

    /* Step 2 — Normalize every floor to 0.0–1.0 coordinate space */
    sessionLog('info', 'Normalizing coordinates…');
    for (const [floorNum, floorData] of Object.entries(raw.floors)) {
      const { normalized, bounds } = normalize(floorData);
      SESSION.normalized[floorNum] = normalized;
      SESSION.bounds[floorNum]     = bounds;
    }
    sessionLog('ok', 'All floors normalized successfully.');

    /* Respond with a preview-ready summary */
    res.json({
      sessionId: SESSION.id,
      meta:      SESSION.buildingMeta,
      floors:    buildPreviewSummary(),
      log:       SESSION.log,
    });

  } catch (err) {
    sessionLog('error', err.message);
    res.status(500).json({ error: err.message, log: SESSION.log });
  }
});

/* ═══════════════════════════════════════════════════════════════
   ROUTE: GET /api/preview
   Returns the current normalized data as a lightweight JSON preview
   so the UI can render a mini canvas before committing an export.
═══════════════════════════════════════════════════════════════ */
app.get('/api/preview', (req, res) => {
  if (!SESSION.id) {
    return res.status(404).json({ error: 'No active session. Upload a file first.' });
  }
  res.json({
    sessionId: SESSION.id,
    meta:      SESSION.buildingMeta,
    floors:    SESSION.normalized,
    bounds:    SESSION.bounds,
    log:       SESSION.log,
  });
});

/* ═══════════════════════════════════════════════════════════════
   ROUTE: POST /api/export/kinetic          (Feature Button 1)
   Writes the normalized coordinate JSON into the KINETIC project's
   assets directory AND seeds the PostgreSQL tables.
═══════════════════════════════════════════════════════════════ */
app.post('/api/export/kinetic', async (req, res) => {
  if (!SESSION.id) return res.status(400).json({ error: 'No active session.' });

  const pipeline = [];

  try {
    sessionLog('info', '— KINETIC EXPORT PIPELINE STARTED —');

    /* ── 1: Build the full KINETIC-format JSON ── */
    sessionLog('info', 'Building KINETIC JSON asset…');
    const kineticJson = kineticExporter.buildJSON(SESSION.normalized, SESSION.buildingMeta, SESSION.bounds);
    pipeline.push({ step: 'JSON built', rooms: countRooms(kineticJson), status: 'ok' });

    /* ── 2: Write JSON file into the KINETIC project directory ── */
    sessionLog('info', 'Writing JSON asset to KINETIC project…');
    const writtenPath = kineticExporter.writeAssetFile(kineticJson, SESSION.buildingMeta.name, SESSION.id);
    pipeline.push({ step: 'JSON written', path: writtenPath, status: 'ok' });
    sessionLog('ok', `Wrote → ${writtenPath}`);

    /* ── 3: Seed PostgreSQL ── */
    sessionLog('info', 'Seeding PostgreSQL tables…');
    const dbResult = await kineticExporter.seedDatabase(kineticJson, SESSION.buildingMeta);
    pipeline.push({
      step:      'DB seeded',
      buildingId: dbResult.buildingId,
      floors:    dbResult.floorsInserted,
      rooms:     dbResult.roomsInserted,
      doors:     dbResult.doorsInserted,
      status:    'ok',
    });
    sessionLog('ok', `DB seed complete. Building ID: ${dbResult.buildingId}`);

    sessionLog('ok', '— KINETIC EXPORT COMPLETE —');

    res.json({
      success:   true,
      pipeline,
      assetPath: writtenPath,
      buildingId: dbResult.buildingId,
      log:       SESSION.log,
    });

  } catch (err) {
    sessionLog('error', `KINETIC export failed: ${err.message}`);
    res.status(500).json({ error: err.message, pipeline, log: SESSION.log });
  }
});

/* ═══════════════════════════════════════════════════════════════
   ROUTE: POST /api/export/svg             (Feature Button 2)
   Generates a high-resolution vector SVG of the floor plan and
   streams it directly to the browser as a file download.
   Database is NOT touched by this route.
═══════════════════════════════════════════════════════════════ */
app.post('/api/export/svg', (req, res) => {
  if (!SESSION.id) return res.status(400).json({ error: 'No active session.' });

  const targetFloor = parseInt(req.body.floor) || 1;

  try {
    sessionLog('info', `Generating SVG for Floor ${targetFloor}…`);

    const floorData = SESSION.normalized[targetFloor];
    if (!floorData) {
      return res.status(404).json({ error: `Floor ${targetFloor} not found in parsed data.` });
    }

    const svgString = svgExporter.generate({
      floorData,
      bounds:    SESSION.bounds[targetFloor],
      meta:      SESSION.buildingMeta,
      floorNum:  targetFloor,
      sessionId: SESSION.id,
    });

    const filename = `KINETIC_${SESSION.buildingMeta.name.replace(/\s+/g, '_')}_F${targetFloor}.svg`;

    sessionLog('ok', `SVG generated (${(svgString.length / 1024).toFixed(1)} KB) → browser download`);

    /* Stream as a browser download — no DB, no file written locally */
    res.setHeader('Content-Type',        'image/svg+xml');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length',      Buffer.byteLength(svgString, 'utf8'));
    res.send(svgString);

  } catch (err) {
    sessionLog('error', `SVG export failed: ${err.message}`);
    res.status(500).json({ error: err.message, log: SESSION.log });
  }
});

/* ── Helper: build a concise floor summary for the UI ── */
function buildPreviewSummary() {
  const summary = {};
  for (const [floor, data] of Object.entries(SESSION.normalized)) {
    summary[floor] = {
      rooms:   (data.rooms  || []).length,
      doors:   (data.doors  || []).length,
      exits:   (data.exits  || []).length,
      hazards: (data.hazards || []).length,
      walls:   (data.walls  || []).length,
    };
  }
  return summary;
}

function countRooms(kineticJson) {
  return Object.values(kineticJson.floors || {})
    .reduce((n, f) => n + (f.rooms || []).length, 0);
}

/* ── Error middleware ── */
app.use((err, req, res, next) => {
  console.error(chalk.red('[SERVER ERROR]'), err.message);
  res.status(err.status || 500).json({ error: err.message });
});

/* ── Boot ── */
app.listen(PORT, () => {
  console.log(chalk.green(`
╔══════════════════════════════════════════════════════╗
║   KINETIC Blueprint Converter  ·  v1.0.0             ║
║   http://localhost:${PORT}                             ║
║                                                      ║
║   Upload:          POST /api/upload                  ║
║   Preview:         GET  /api/preview                 ║
║   → Export KINETIC POST /api/export/kinetic          ║
║   → Export SVG     POST /api/export/svg              ║
╚══════════════════════════════════════════════════════╝
  `));
});

module.exports = app;