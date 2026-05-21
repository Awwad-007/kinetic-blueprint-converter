/* ═══════════════════════════════════════════════════════════════
   src/exporters/svg.js
   Generates a high-resolution A1-size vector SVG of the floor plan.
   No database access. No file written locally. Pure string output.

   Output characteristics:
     Canvas:  2970 × 2100 (A1 landscape, 1px ≡ 1mm at 72dpi baseline)
     Rooms:   filled rectangles with cross-corner tick marks
     Walls:   1px dark lines
     Doors:   arc symbols + lock state line
     Exits:   pulsed-border green boxes with EXIT label
     Hazards: red hatched rectangles
     Labels:  UPPERCASE Helvetica/monospace
     Legend:  bottom-right panel
     Title:   bottom-left title block with building name, date, floor
     Scale:   bottom bar showing physical extent

   The SVG is self-contained (no external fonts or images required).
═══════════════════════════════════════════════════════════════ */

'use strict';

/* ─── Canvas dimensions (mm equivalent at 1px:1mm scale) ─────── */
const W = 2970;   // A1 landscape width
const H = 2100;   // A1 landscape height

/* ─── Map padding inside canvas ─────────────────────────────── */
const MAP_LEFT   = 80;
const MAP_TOP    = 100;
const MAP_RIGHT  = W - 80;
const MAP_BOTTOM = H - 180;
const MAP_W      = MAP_RIGHT  - MAP_LEFT;
const MAP_H      = MAP_BOTTOM - MAP_TOP;

/* ─── Color palette (prints well on white + screen) ─────────── */
const C = {
  bg:          '#f8f9f6',
  mapBg:       '#f0f2ee',
  gridLine:    '#dde5dd',
  border:      '#1a2a1a',
  wall:        '#2a3a2a',
  roomFill:    '#e8ede8',
  roomStroke:  '#4a6a4a',
  corridorFill:'#e0e8e0',
  hazardFill:  '#fff0f0',
  hazardStroke:'#cc0033',
  exitFill:    '#edfff0',
  exitStroke:  '#00aa22',
  doorColor:   '#005500',
  doorLocked:  '#cc0033',
  labelColor:  '#1a3a1a',
  dimColor:    '#667766',
  titleBg:     '#1a2a1a',
  titleText:   '#e8ffe8',
  legendBg:    '#f4f8f4',
  accentNeon:  '#00aa22',
};

/* ─── Coordinate map: normalised 0–1 → SVG canvas pixels ─────── */
function mx(nx) { return MAP_LEFT  + nx * MAP_W; }
function my(ny) { return MAP_TOP   + ny * MAP_H; }
function mw(nw) { return nw * MAP_W; }
function mh(nh) { return nh * MAP_H; }

/* ─── Escape XML special chars in label text ────────────────── */
function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ═══════════════════════════════════════════════════════════════
   generate({ floorData, bounds, meta, floorNum, sessionId })
═══════════════════════════════════════════════════════════════ */
function generate({ floorData, bounds, meta, floorNum }) {
  const parts = [];   // SVG fragment strings accumulated in order

  const today = new Date().toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  });

  /* ─────────────── SVG HEADER ─────────────────────────────── */
  parts.push(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg"
     viewBox="0 0 ${W} ${H}"
     width="${W}mm" height="${H}mm"
     font-family="'Helvetica Neue', Helvetica, Arial, monospace"
     shape-rendering="crispEdges">

  <title>KINETIC — ${esc(meta.name)} — Floor ${floorNum}</title>
  <desc>Auto-generated floor plan. KINETIC Blueprint Converter v1.0</desc>

  <defs>
    <!-- Hazard hatch pattern -->
    <pattern id="hazardHatch" patternUnits="userSpaceOnUse" width="14" height="14" patternTransform="rotate(45)">
      <line x1="0" y1="0" x2="0" y2="14" stroke="${C.hazardStroke}" stroke-width="2" stroke-opacity="0.25"/>
    </pattern>
    <!-- Grid pattern -->
    <pattern id="gridPat" patternUnits="userSpaceOnUse" width="50" height="50">
      <path d="M 50 0 L 0 0 0 50" fill="none" stroke="${C.gridLine}" stroke-width="0.5"/>
    </pattern>
    <!-- Drop shadow -->
    <filter id="shadow" x="-5%" y="-5%" width="110%" height="110%">
      <feDropShadow dx="2" dy="2" stdDeviation="3" flood-color="#0005"/>
    </filter>
  </defs>
`);

  /* ─────────────── BACKGROUND ─────────────────────────────── */
  parts.push(`
  <!-- Background -->
  <rect width="${W}" height="${H}" fill="${C.bg}"/>

  <!-- Outer border -->
  <rect x="20" y="20" width="${W-40}" height="${H-40}"
        fill="none" stroke="${C.border}" stroke-width="2"/>

  <!-- Map area background -->
  <rect x="${MAP_LEFT}" y="${MAP_TOP}" width="${MAP_W}" height="${MAP_H}"
        fill="${C.mapBg}" stroke="${C.border}" stroke-width="1.5" filter="url(#shadow)"/>

  <!-- Grid -->
  <rect x="${MAP_LEFT}" y="${MAP_TOP}" width="${MAP_W}" height="${MAP_H}"
        fill="url(#gridPat)"/>
`);

  /* ─────────────── HEADER BAR ─────────────────────────────── */
  parts.push(`
  <!-- Header bar -->
  <rect x="20" y="20" width="${W-40}" height="70" fill="${C.titleBg}"/>
  <text x="50" y="55" fill="${C.titleText}" font-size="28" font-weight="bold" letter-spacing="4">
    KINETIC EMERGENCY MANAGEMENT SYSTEM
  </text>
  <text x="50" y="78" fill="#88cc88" font-size="16" letter-spacing="2">
    FLOOR PLAN EXPORT — CONFIDENTIAL
  </text>
  <text x="${W-50}" y="55" fill="${C.accentNeon}" font-size="20"
        text-anchor="end" font-weight="bold">
    ${esc(meta.name.toUpperCase())}
  </text>
  <text x="${W-50}" y="78" fill="#aaaaaa" font-size="14" text-anchor="end">
    FLOOR ${floorNum} &nbsp;|&nbsp; ${esc(today)}
  </text>
`);

  /* ─────────────── ROOMS ──────────────────────────────────── */
  parts.push('\n  <!-- ─── ROOMS ─── -->');

  for (const room of (floorData.rooms || [])) {
    const rx = mx(room.x), ry = my(room.y);
    const rw = mw(room.w), rh = mh(room.h);

    const isHazard   = room.roomType === 'hazard';
    const isExit     = room.roomType === 'exit'   || room.isExit;
    const isCorridor = room.roomType === 'corridor';

    const fill   = isHazard ? C.hazardFill : isExit ? C.exitFill : isCorridor ? C.corridorFill : C.roomFill;
    const stroke = isHazard ? C.hazardStroke : isExit ? C.exitStroke : C.roomStroke;
    const sw     = isHazard ? 2.5 : 1.5;

    parts.push(`
  <g id="room-${esc(room.id)}">
    <rect x="${rx.toFixed(1)}" y="${ry.toFixed(1)}"
          width="${rw.toFixed(1)}" height="${rh.toFixed(1)}"
          fill="${fill}" fill-opacity="0.85"
          stroke="${stroke}" stroke-width="${sw}"/>`);

    /* Hazard hatching */
    if (isHazard) {
      parts.push(`
    <rect x="${rx.toFixed(1)}" y="${ry.toFixed(1)}"
          width="${rw.toFixed(1)}" height="${rh.toFixed(1)}"
          fill="url(#hazardHatch)"/>`);
    }

    /* Corner tick marks */
    const tc = 14;
    for (const [cx, cy, sx, sy] of [[rx,ry,1,1],[rx+rw,ry,-1,1],[rx,ry+rh,1,-1],[rx+rw,ry+rh,-1,-1]]) {
      parts.push(`
    <path d="M ${cx.toFixed(1)} ${(cy+sy*tc).toFixed(1)} L ${cx.toFixed(1)} ${cy.toFixed(1)} L ${(cx+sx*tc).toFixed(1)} ${cy.toFixed(1)}"
          fill="none" stroke="${stroke}" stroke-width="1.5"/>`);
    }

    /* Room label */
    const fontSize = Math.max(8, Math.min(18, rw * 0.06));
    const lx = (rx + rw / 2).toFixed(1);
    const ly = (ry + rh / 2).toFixed(1);

    parts.push(`
    <text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle"
          font-size="${fontSize.toFixed(1)}" fill="${C.labelColor}" font-weight="600"
          letter-spacing="1">${esc(room.label)}</text>`);

    /* Room type sub-label */
    if (room.roomType && room.roomType !== 'general') {
      parts.push(`
    <text x="${lx}" y="${(parseFloat(ly) + fontSize + 3).toFixed(1)}"
          text-anchor="middle" dominant-baseline="middle"
          font-size="${(fontSize * 0.65).toFixed(1)}" fill="${C.dimColor}"
          letter-spacing="0.5">${esc(room.roomType.toUpperCase())}</text>`);
    }

    parts.push(`\n  </g>`);
  }

  /* ─────────────── WALLS ──────────────────────────────────── */
  if ((floorData.walls || []).length > 0) {
    parts.push('\n  <!-- ─── WALLS ─── -->\n  <g id="walls" stroke="${C.wall}" stroke-width="2.5" stroke-linecap="round">');
    for (const w of floorData.walls) {
      if (w.isCircle) {
        parts.push(`    <circle cx="${mx(w.cx).toFixed(1)}" cy="${my(w.cy).toFixed(1)}" r="8" fill="${C.wall}"/>`);
      } else {
        parts.push(`    <line x1="${mx(w.x1).toFixed(1)}" y1="${my(w.y1).toFixed(1)}" x2="${mx(w.x2).toFixed(1)}" y2="${my(w.y2).toFixed(1)}" stroke="${C.wall}"/>`);
      }
    }
    parts.push('  </g>');
  }

  /* ─────────────── HAZARD ZONES ───────────────────────────── */
  parts.push('\n  <!-- ─── HAZARD ZONES ─── -->');
  for (const hz of (floorData.hazards || [])) {
    const hx = mx(hz.x), hy = my(hz.y);
    const hw = mw(hz.w), hh = mh(hz.h);
    parts.push(`
  <g id="hazard-${esc(hz.label || 'z')}">
    <rect x="${hx.toFixed(1)}" y="${hy.toFixed(1)}"
          width="${hw.toFixed(1)}" height="${hh.toFixed(1)}"
          fill="${C.hazardFill}" stroke="${C.hazardStroke}"
          stroke-width="2.5" stroke-dasharray="10 4"/>
    <text x="${(hx + hw/2).toFixed(1)}" y="${(hy + hh/2).toFixed(1)}"
          text-anchor="middle" dominant-baseline="middle"
          font-size="16" fill="${C.hazardStroke}" font-weight="bold" letter-spacing="2">
      ⚠ ${esc((hz.label || 'HAZARD').toUpperCase())}
    </text>
  </g>`);
  }

  /* ─────────────── EXITS / STAIRS ─────────────────────────── */
  parts.push('\n  <!-- ─── EXITS ─── -->');
  for (const exit of (floorData.exits || [])) {
    const ex = mx(exit.x), ey = my(exit.y);
    parts.push(`
  <g id="exit-${ex.toFixed(0)}-${ey.toFixed(0)}">
    <rect x="${(ex-20).toFixed(1)}" y="${(ey-12).toFixed(1)}" width="40" height="24"
          rx="2" fill="${C.exitFill}" stroke="${C.exitStroke}" stroke-width="2"/>
    <text x="${ex.toFixed(1)}" y="${(ey+1).toFixed(1)}"
          text-anchor="middle" dominant-baseline="middle"
          font-size="9" font-weight="bold" fill="${C.exitStroke}" letter-spacing="1">
      ${esc(exit.label || 'EXIT')}
    </text>
  </g>`);
  }

  /* ─────────────── DOORS ──────────────────────────────────── */
  parts.push('\n  <!-- ─── DOORS ─── -->');
  for (const door of (floorData.doors || [])) {
    const dx = mx(door.x), dy = my(door.y);
    const size = 20;
    const color = door.locked ? C.doorLocked : C.doorColor;
    const dashArr = door.locked ? 'none' : '6 3';

    if (door.horiz) {
      parts.push(`
  <g id="door-${esc(door.id)}">
    <line x1="${(dx-size).toFixed(1)}" y1="${dy.toFixed(1)}"
          x2="${(dx+size).toFixed(1)}" y2="${dy.toFixed(1)}"
          stroke="${color}" stroke-width="${door.locked ? 3.5 : 2}"
          stroke-dasharray="${dashArr}"/>
    <path d="M ${(dx-size).toFixed(1)} ${dy.toFixed(1)} A ${size} ${size} 0 0 1 ${dx.toFixed(1)} ${(dy-size).toFixed(1)}"
          fill="none" stroke="${color}" stroke-width="1" stroke-opacity="0.4"/>
    <text x="${dx.toFixed(1)}" y="${(dy-26).toFixed(1)}"
          text-anchor="middle" font-size="9" fill="${color}" letter-spacing="0.5">
      ${esc(door.id)}
    </text>
  </g>`);
    } else {
      parts.push(`
  <g id="door-${esc(door.id)}">
    <line x1="${dx.toFixed(1)}" y1="${(dy-size).toFixed(1)}"
          x2="${dx.toFixed(1)}" y2="${(dy+size).toFixed(1)}"
          stroke="${color}" stroke-width="${door.locked ? 3.5 : 2}"
          stroke-dasharray="${dashArr}"/>
    <path d="M ${dx.toFixed(1)} ${(dy-size).toFixed(1)} A ${size} ${size} 0 0 0 ${(dx+size).toFixed(1)} ${dy.toFixed(1)}"
          fill="none" stroke="${color}" stroke-width="1" stroke-opacity="0.4"/>
    <text x="${(dx+14).toFixed(1)}" y="${(dy-size-4).toFixed(1)}"
          font-size="9" fill="${color}" letter-spacing="0.5">
      ${esc(door.id)}
    </text>
  </g>`);
    }
  }

  /* ─────────────── LEGEND ─────────────────────────────────── */
  const LX = MAP_RIGHT + 10;
  const LY = MAP_TOP;
  const LW = W - LX - 30;

  parts.push(`
  <!-- ─── LEGEND ─── -->
  <rect x="${LX}" y="${LY}" width="${LW}" height="380"
        fill="${C.legendBg}" stroke="${C.border}" stroke-width="1"/>
  <text x="${LX + LW/2}" y="${LY + 24}" text-anchor="middle"
        font-size="14" font-weight="bold" fill="${C.border}" letter-spacing="2">LEGEND</text>`);

  const legendItems = [
    { fill: C.roomFill,    stroke: C.roomStroke,    label: 'Room / Space'   },
    { fill: C.corridorFill,stroke: C.roomStroke,    label: 'Corridor'       },
    { fill: C.exitFill,    stroke: C.exitStroke,    label: 'Exit / Stair'   },
    { fill: C.hazardFill,  stroke: C.hazardStroke,  label: 'Hazard Zone'    },
    { fill: 'none',        stroke: C.doorColor,     label: 'Door (Unlocked)', dash: '6 3' },
    { fill: 'none',        stroke: C.doorLocked,    label: 'Door (Locked)'  },
    { fill: C.wall,        stroke: 'none',          label: 'Wall Segment'   },
  ];

  legendItems.forEach(({ fill, stroke, label, dash }, i) => {
    const ly2 = LY + 50 + i * 42;
    parts.push(`
  <rect x="${LX+12}" y="${ly2}" width="28" height="18" rx="2"
        fill="${fill}" stroke="${stroke}" stroke-width="2" stroke-dasharray="${dash || 'none'}"/>
  <text x="${LX+50}" y="${ly2+13}" font-size="13" fill="${C.labelColor}">${esc(label)}</text>`);
  });

  /* ─────────────── TITLE BLOCK ────────────────────────────── */
  parts.push(`
  <!-- ─── TITLE BLOCK ─── -->
  <rect x="20" y="${H-160}" width="${W/2 - 20}" height="140" fill="${C.titleBg}"/>

  <text x="40" y="${H-130}" fill="${C.titleText}" font-size="20" font-weight="bold" letter-spacing="3">
    ${esc(meta.name.toUpperCase())}
  </text>
  <text x="40" y="${H-108}" fill="#88cc88" font-size="13" letter-spacing="1">
    ${esc(meta.address || 'LOCATION NOT SPECIFIED')}
  </text>
  <line x1="40" y1="${H-96}" x2="${W/2-40}" y2="${H-96}" stroke="#336633" stroke-width="0.5"/>

  <text x="40" y="${H-80}" fill="#aaaaaa" font-size="11">
    DRAWING TYPE:  FLOOR PLAN — LEVEL ${floorNum}
  </text>
  <text x="40" y="${H-62}" fill="#aaaaaa" font-size="11">
    SCALE:         1:${computeScale(bounds)} &nbsp;&nbsp; UNITS: mm
  </text>
  <text x="40" y="${H-44}" fill="#aaaaaa" font-size="11">
    DATE:          ${esc(today)}
  </text>
  <text x="40" y="${H-26}" fill="#aaaaaa" font-size="11">
    GENERATED BY:  KINETIC Blueprint Converter v1.0
  </text>
`);

  /* ─────────────── SCALE BAR ──────────────────────────────── */
  const physRange = bounds ? (bounds.rangeX || 50000) : 50000;
  const scalePxPer10m = (MAP_W / physRange) * 10000;
  const SBY = H - 80;
  const SBX = W / 2 + 20;

  parts.push(`
  <!-- ─── SCALE BAR ─── -->
  <g font-size="11" fill="${C.dimColor}">
    <text x="${SBX}" y="${SBY - 6}">SCALE BAR (10m intervals)</text>
    ${[0,1,2,3,4,5].map(i => `
    <rect x="${(SBX + i * scalePxPer10m).toFixed(1)}" y="${SBY}"
          width="${scalePxPer10m.toFixed(1)}" height="10"
          fill="${i%2===0 ? C.border : C.bg}" stroke="${C.border}" stroke-width="0.5"/>
    <text x="${(SBX + i * scalePxPer10m).toFixed(1)}" y="${SBY + 22}"
          text-anchor="middle">${i * 10}m</text>`).join('')}
    <text x="${(SBX + 5 * scalePxPer10m).toFixed(1)}" y="${SBY + 22}"
          text-anchor="middle">50m</text>
  </g>
`);

  /* ─────────────── NORTH ARROW ────────────────────────────── */
  const NAX = W - 120, NAY = H - 120;
  parts.push(`
  <!-- ─── NORTH ARROW ─── -->
  <g id="northArrow" transform="translate(${NAX},${NAY})">
    <polygon points="0,-40 8,0 0,-8 -8,0" fill="${C.titleBg}"/>
    <polygon points="0,-40 -8,0 0,-8 8,0" fill="${C.dimColor}"/>
    <circle cx="0" cy="0" r="18" fill="none" stroke="${C.border}" stroke-width="1.5"/>
    <text x="0" y="-46" text-anchor="middle" font-size="14"
          font-weight="bold" fill="${C.border}">N</text>
  </g>
`);

  /* ─────────────── SVG CLOSE ──────────────────────────────── */
  parts.push('\n</svg>');

  return parts.join('');
}

/* ─── Compute a rounded map scale string ── */
function computeScale(bounds) {
  if (!bounds) return '500';
  const physRange = bounds.rangeX || 50000;  // mm
  const ratio     = physRange / MAP_W;        // mm per px
  const rounded   = Math.round(ratio / 5) * 5 || 1;
  return String(rounded);
}

module.exports = { generate };