/* ═══════════════════════════════════════════════════════════════
   src/parsers/index.js
   Routes the uploaded file to the correct parser by extension.
   Returns a unified geometry object regardless of source format.
═══════════════════════════════════════════════════════════════ */

'use strict';

const parseDXF = require('./dxf');
const parseIFC = require('./ifc');

/**
 * Main parser entry point.
 *
 * @param {string} filePath  - Absolute path to the uploaded file
 * @param {string} fileType  - 'dxf' | 'ifc' | 'dwg'
 * @returns {Promise<ParsedBuilding>}
 *
 * ParsedBuilding shape:
 * {
 *   totalEntities: number,
 *   floors: {
 *     [floorNumber: string]: {
 *       walls:   WallSegment[],
 *       rooms:   RawRoom[],
 *       doors:   RawDoor[],
 *       exits:   RawExit[],
 *       hazards: RawHazard[],
 *       labels:  RawLabel[],
 *     }
 *   }
 * }
 */
async function parseBlueprint(filePath, fileType) {
  switch (fileType) {
    case 'dxf':
    case 'dwg':   // DWG is handled via dxf-parser after optional ODA conversion
      return parseDXF(filePath);

    case 'ifc':
      return parseIFC(filePath);

    default:
      throw new Error(
        `No parser available for file type ".${fileType}". ` +
        `Supported formats: .dxf, .dwg, .ifc`
      );
  }
}

module.exports = parseBlueprint;