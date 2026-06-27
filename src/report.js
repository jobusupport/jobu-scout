'use strict';

/**
 * report.js
 * Voodoo Scout — Report Generator (Phase 5)
 *
 * Produces Word (.docx) and PDF scouting reports matching the Bob Jones format:
 *   - Cover page
 *   - Pitching Summary table  (all pitchers, App/IP/ERA/WHIP/SO7/BB7/S%)
 *   - Hitting Summary table   (all batters, full stat line)
 *   - Fielding Summary table  (errors + positions)
 *   - AI Analysis sections    (batting, pitching, tendencies, game plan)
 *   - Per-player pages        (fan spray chart + stats box + swing decisions + scout note, all on one page)
 */

const fs   = require('fs');
const path = require('path');
const { getPGDataForTeam } = require('./pg-reader');

// ─── Fan/Wedge Spray Chart SVG (Bob Jones style) ──────────────────────────────
// Draws a baseball field fan with shaded wedges sized by zone percentage.
// Zones from left to right: LF, CF, RF (outfield), then 3B, SS, 2B, 1B (infield), P/C (center)
function generateFanSprayChartSVG(sprayPct = {}, playerLabel = '') {
  const W = 300, H = 260;
  const CX = 150, CY = 240; // home plate apex
  const R_OF = 210;          // outfield arc radius
  const R_IF = 105;          // infield arc radius

  // Zone definitions: [label, startAngle, endAngle, isOutfield]
  // Angles in degrees, 0 = straight up (CF), negative = left, positive = right
  // Field spans roughly -52° (LF line) to +52° (RF line)
  const zones = [
    { key: 'LF',  label: 'LF',  a1: -52, a2: -28, outer: R_OF, inner: R_IF },
    { key: 'CF',  label: 'CF',  a1: -28, a2:  28, outer: R_OF, inner: R_IF },
    { key: 'RF',  label: 'RF',  a1:  28, a2:  52, outer: R_OF, inner: R_IF },
    { key: '3B',  label: '3B',  a1: -52, a2: -28, outer: R_IF, inner: 0    },
    { key: 'SS',  label: 'SS',  a1: -28, a2:  -8, outer: R_IF, inner: 0    },
    { key: '2B',  label: '2B',  a1:   8, a2:  28, outer: R_IF, inner: 0    },
    { key: '1B',  label: '1B',  a1:  28, a2:  52, outer: R_IF, inner: 0    },
    { key: 'P',   label: 'P/C', a1:  -8, a2:   8, outer: R_IF, inner: 0    },
  ];

  function toRad(deg) { return (deg - 90) * Math.PI / 180; }

  function arcPoint(r, angleDeg) {
    const rad = toRad(angleDeg);
    return { x: CX + r * Math.cos(rad), y: CY + r * Math.sin(rad) };
  }

  function wedgePath(z, r_outer, r_inner) {
    const p1 = arcPoint(r_outer, z.a1);
    const p2 = arcPoint(r_outer, z.a2);
    const largeArc = (z.a2 - z.a1) > 180 ? 1 : 0;

    if (r_inner === 0) {
      // Triangle to apex
      return `M ${CX},${CY} L ${p1.x.toFixed(1)},${p1.y.toFixed(1)} A ${r_outer},${r_outer} 0 ${largeArc},1 ${p2.x.toFixed(1)},${p2.y.toFixed(1)} Z`;
    } else {
      const p3 = arcPoint(r_inner, z.a2);
      const p4 = arcPoint(r_inner, z.a1);
      return `M ${p4.x.toFixed(1)},${p4.y.toFixed(1)} A ${r_inner},${r_inner} 0 ${largeArc},1 ${p3.x.toFixed(1)},${p3.y.toFixed(1)} L ${p2.x.toFixed(1)},${p2.y.toFixed(1)} A ${r_outer},${r_outer} 0 ${largeArc},0 ${p1.x.toFixed(1)},${p1.y.toFixed(1)} Z`;
    }
  }

  // Shade intensity based on pct — light green to dark green
  function zoneColor(pct) {
    if (!pct || pct === 0) return '#f0f0f0';
    if (pct < 8)  return '#c8e6c9';  // very light green
    if (pct < 15) return '#81c784';  // light green
    if (pct < 25) return '#4caf50';  // medium green
    if (pct < 35) return '#388e3c';  // dark green
    return '#1b5e20';                 // very dark green
  }

  // Label position: midpoint angle, midpoint radius
  function labelPos(z) {
    const midAngle = (z.a1 + z.a2) / 2;
    const midR = z.inner === 0
      ? (z.outer * 0.55)
      : ((z.outer + z.inner) / 2);
    return arcPoint(midR, midAngle);
  }

  // Build wedge paths
  let wedgesHtml = '';
  let labelsHtml = '';

  for (const z of zones) {
    const pct = sprayPct[z.key] || 0;
    const color = zoneColor(pct);
    const path_d = wedgePath(z, z.outer, z.inner);
    wedgesHtml += `<path d="${path_d}" fill="${color}" stroke="white" stroke-width="1.5"/>`;

    // Only label if pct > 0
    if (pct > 0) {
      const lp = labelPos(z);
      const isPC = z.key === 'P';
      const labelText = isPC ? `P/C ${pct}%` : `${pct}%`;
      const fontSize = isPC ? 8 : 9;
      labelsHtml += `<text x="${lp.x.toFixed(1)}" y="${lp.y.toFixed(1)}" text-anchor="middle" dominant-baseline="middle" font-size="${fontSize}" font-weight="bold" fill="white" stroke="#1b5e20" stroke-width="0.3">${labelText}</text>`;
    }
  }

  // Foul lines
  const lfLine = arcPoint(R_OF + 10, -52);
  const rfLine = arcPoint(R_OF + 10,  52);

  // Outfield arc
  const arcStart = arcPoint(R_OF, -52);
  const arcEnd   = arcPoint(R_OF,  52);

  // Infield arc
  const ifStart = arcPoint(R_IF, -52);
  const ifEnd   = arcPoint(R_IF,  52);

  // Division lines (spokes at zone boundaries)
  const divAngles = [-28, 28, -8, 8];
  let spokesHtml = divAngles.map(a => {
    const p = arcPoint(R_OF + 5, a);
    return `<line x1="${CX}" y1="${CY}" x2="${p.x.toFixed(1)}" y2="${p.y.toFixed(1)}" stroke="white" stroke-width="1.5" stroke-dasharray="none"/>`;
  }).join('');

  // Additional infield spokes
  const ifDivAngles = [-52, -28, -8, 8, 28, 52];
  spokesHtml += ifDivAngles.map(a => {
    const inner = arcPoint(0, a);
    const outer = arcPoint(R_IF, a);
    return `<line x1="${CX}" y1="${CY}" x2="${outer.x.toFixed(1)}" y2="${outer.y.toFixed(1)}" stroke="white" stroke-width="1" opacity="0.5"/>`;
  }).join('');

  // Home plate
  const plateSvg = `<polygon points="${CX-5},${CY} ${CX-3},${CY-5} ${CX+3},${CY-5} ${CX+5},${CY}" fill="white" stroke="#666" stroke-width="0.8"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="white"/>
  <!-- Background field shape -->
  <path d="M ${CX},${CY} L ${arcStart.x.toFixed(1)},${arcStart.y.toFixed(1)} A ${R_OF},${R_OF} 0 0,1 ${arcEnd.x.toFixed(1)},${arcEnd.y.toFixed(1)} Z" fill="#e8f5e9" stroke="#ccc" stroke-width="1"/>
  <!-- Shaded wedges -->
  ${wedgesHtml}
  <!-- Infield arc border -->
  <path d="M ${ifStart.x.toFixed(1)},${ifStart.y.toFixed(1)} A ${R_IF},${R_IF} 0 0,1 ${ifEnd.x.toFixed(1)},${ifEnd.y.toFixed(1)}" fill="none" stroke="white" stroke-width="1.5"/>
  <!-- Foul lines -->
  <line x1="${CX}" y1="${CY}" x2="${lfLine.x.toFixed(1)}" y2="${lfLine.y.toFixed(1)}" stroke="#999" stroke-width="1" stroke-dasharray="4,3"/>
  <line x1="${CX}" y1="${CY}" x2="${rfLine.x.toFixed(1)}" y2="${rfLine.y.toFixed(1)}" stroke="#999" stroke-width="1" stroke-dasharray="4,3"/>
  <!-- Zone percentage labels -->
  ${labelsHtml}
  <!-- Home plate -->
  ${plateSvg}
</svg>`;
}

// Convert SVG string → PNG buffer (tries sharp, canvas, svg2img in order)
async function svgToPngBuffer(svgStr) {
  try {
    const sharp = require('sharp');
    return await sharp(Buffer.from(svgStr)).png().toBuffer();
  } catch {}

  try {
    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    const img    = await loadImage(Buffer.from(svgStr));
    const canvas = createCanvas(img.width || 300, img.height || 260);
    const ctx    = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return canvas.toBuffer('image/png');
  } catch {}

  try {
    const svg2img = require('svg2img');
    return await new Promise((resolve, reject) => {
      svg2img(svgStr, { format: 'png', width: 300, height: 260 }, (err, buf) => {
        if (err) reject(err); else resolve(buf);
      });
    });
  } catch {}

  return null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitize(value) {
  return String(value || '').replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, ' ').trim();
}

function fmt(value, decimals = 3) {
  if (value === null || value === undefined) return '—';
  const n = parseFloat(value);
  if (isNaN(n)) return '—';
  return n.toFixed(decimals);
}

function fmtAvg(value) {
  if (value === null || value === undefined) return '—';
  const n = parseFloat(value);
  if (isNaN(n)) return '—';
  return n.toFixed(3).replace(/^0/, '');
}

function toNum(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function firstNum(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function calcBattingMetrics(line = {}, playerStats = {}, adv = {}) {
  const ab   = toNum(line.total_ab ?? playerStats.ab);
  const h    = toNum(line.total_h  ?? playerStats.h);
  const bb   = toNum(line.total_bb ?? playerStats.bb);
  const hbp  = toNum(line.total_hbp ?? playerStats.hbp);
  const sac  = toNum(line.total_sac ?? line.total_sf ?? playerStats.sf ?? playerStats.sac);
  const so   = toNum(line.total_so ?? playerStats.k ?? playerStats.so);
  const hr   = toNum(line.total_hr ?? playerStats.hr);
  const dbl  = toNum(line.total_2b ?? playerStats['2b'] ?? playerStats.doubles);
  const tpl  = toNum(line.total_3b ?? playerStats['3b'] ?? playerStats.triples);
  const sb   = toNum(line.total_sb ?? playerStats.sb ?? playerStats.sba);
  const pa   = ab + bb + hbp + sac;
  const xbh  = dbl + tpl + hr;
  const tb   = (h - xbh) + (2 * dbl) + (3 * tpl) + (4 * hr);

  const avg = ab > 0 ? h / ab : firstNum(line.batting_avg, playerStats.avg, playerStats.ba);
  const obpDen = ab + bb + hbp + sac;
  const obp = obpDen > 0
    ? (h + bb + hbp) / obpDen
    : firstNum(line.obp, playerStats.obp);
  const slg = ab > 0 ? tb / ab : firstNum(line.slg, playerStats.slg);
  const ops = (obp !== null && slg !== null) ? obp + slg : firstNum(line.ops, playerStats.ops);
  const kPct = pa > 0 ? (so / pa * 100) : firstNum(adv.k_pct, playerStats.k_pct);
  const bbPct = pa > 0 ? (bb / pa * 100) : firstNum(adv.bb_pct, playerStats.bb_pct);
  const gbPct = firstNum(adv.gb_pct, playerStats.gb_pct);
  const bunts = firstNum(adv.sac_count, line.total_sac, playerStats.sac_count, playerStats.bunts);

  return { ab, h, bb, hbp, sac, so, hr, dbl, tpl, sb, pa, xbh, avg, obp, slg, ops, kPct, bbPct, gbPct, bunts };
}

function pct(value) {
  if (value === null || value === undefined) return '—';
  const n = parseFloat(value);
  if (isNaN(n)) return '—';
  return n.toFixed(1) + '%';
}

function confidenceBadge(level) {
  const map = { high: '● HIGH', medium: '◑ MEDIUM', low: '○ LOW' };
  return map[level] || level || 'UNKNOWN';
}

function threatColor(level) {
  const map = { high: 'C00000', medium: 'E36C09', low: '375623' };
  return map[level] || '000000';
}

// ─── docx Builders ────────────────────────────────────────────────────────────

async function buildDocx(analysis, outputPath) {
  if (!analysis || typeof analysis !== 'object') {
    throw new Error('buildDocx: analysis object is null or undefined');
  }

  const _pgForDocx = analysis._pgData ||
    getPGDataForTeam(analysis._bundle?.team?.team_name || analysis.reportMeta?.teamName || '');
  const jerseyMap = {
    ...(_pgForDocx?.jerseyMap || {}),
    ...(analysis._bundle?.jerseyMap || {}),
  };

  const {
    Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
    HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType,
    VerticalAlign, PageNumber, PageBreak, LevelFormat, Header, Footer,
    TabStopType, TabStopPosition, ImageRun,
  } = require('docx');

  const a         = analysis;
  const teamName  = a.reportMeta?.teamName || a._bundle?.team?.team_name || 'Unknown Team';
  const _ar        = a._bundle?.activeRoster || {};
  const activeSet  = _ar.players instanceof Set ? _ar.players : new Set(_ar.players || []);
  const arWindow   = _ar.gameCount ?? 0;
  const arTotal    = _ar.totalGamesWindow ?? 10;
  const generated = a._generatedAt
    ? new Date(a._generatedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
    : new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const games      = a.reportMeta?.gamesAnalyzed ?? 0;
  const confidence = confidenceBadge(a.reportMeta?.dataConfidence);

  // Color palette
  const NAVY  = '1F3864';
  const BLUE  = '2E75B6';
  const WHITE = 'FFFFFF';
  const BLACK = '000000';
  const LGRAY = 'D9E2F3';
  const MGRAY = 'BDD0EA';
  const ALTROW = 'F5F8FC';

  // Border helpers
  const thinBorder = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
  const allBorders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };
  const noBorder   = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const noBorders  = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };

  // ── Cell factory ──
  function cell(text, opts = {}) {
    const {
      width = 2340, bold = false, color = BLACK, bg = WHITE,
      align = AlignmentType.LEFT, size = 18, colspan, isAlt = false,
    } = opts;
    const fill = isAlt ? ALTROW : bg;
    const cellProps = {
      borders: allBorders,
      width:   { size: width, type: WidthType.DXA },
      shading: { fill, type: ShadingType.CLEAR },
      margins: { top: 50, bottom: 50, left: 100, right: 100 },
      verticalAlign: VerticalAlign.CENTER,
      children: [new Paragraph({
        alignment: align,
        children: [new TextRun({ text: String(text ?? '—'), bold, color, size, font: 'Arial' })],
      })],
    };
    if (colspan) cellProps.columnSpan = colspan;
    return new TableCell(cellProps);
  }

  function hCell(text, width = 2340) {
    return cell(text, { width, bold: true, color: WHITE, bg: NAVY, size: 17, align: AlignmentType.CENTER });
  }

  function sectionHeading(text) {
    return new Paragraph({
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 240, after: 100 },
      border:  { bottom: { style: BorderStyle.SINGLE, size: 8, color: BLUE, space: 1 } },
      children: [new TextRun({ text, bold: true, color: NAVY, size: 26, font: 'Arial' })],
    });
  }

  function subHeading(text) {
    return new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 140, after: 60 },
      children: [new TextRun({ text, bold: true, color: BLUE, size: 20, font: 'Arial' })],
    });
  }

  function bodyPara(text, opts = {}) {
    const { bold = false, color = BLACK, italic = false } = opts;
    return new Paragraph({
      spacing: { after: 100 },
      children: [new TextRun({ text: String(text ?? ''), bold, color, italic, size: 18, font: 'Arial' })],
    });
  }

  function bulletPara(text) {
    return new Paragraph({
      numbering: { reference: 'bullets', level: 0 },
      spacing:   { after: 50 },
      children:  [new TextRun({ text: String(text ?? ''), size: 18, font: 'Arial' })],
    });
  }

  function spacer(size = 100) {
    return new Paragraph({ spacing: { after: size }, children: [new TextRun('')] });
  }

  function labelValue(label, value) {
    return new Paragraph({
      spacing: { after: 70 },
      children: [
        new TextRun({ text: `${label}: `, bold: true, size: 18, font: 'Arial', color: NAVY }),
        new TextRun({ text: String(value ?? '—'), size: 18, font: 'Arial' }),
      ],
    });
  }

  // ── Data lookups ──
  const bundleBatMap  = {};
  for (const b of (a._bundle?.batting  || [])) bundleBatMap[b.player_name]  = b;
  const bundlePitMap  = {};
  for (const p of (a._bundle?.pitching || [])) bundlePitMap[p.player_name]  = p;

  // Advanced player stats (from stats-engine via DB)
  const advPlayerMap = {};
  for (const p of (a._playerAdvanced || [])) advPlayerMap[p.player_name] = p;
  function getAdv(name) {
    if (advPlayerMap[name]) return advPlayerMap[name];
    const norm = n => n.toLowerCase().replace(/[^a-z ]/g, '').trim();
    return Object.values(advPlayerMap).find(p => norm(p.player_name) === norm(name)) || {};
  }

  // Opponent batters advanced (is_our_team=0) — already filtered by getTeamBundle
  const oppBatMap = {};
  for (const p of (a._bundle?.opponentBatters || [])) oppBatMap[p.player_name] = p;

  // All batters/pitchers on the scouted team (opponent only, is_our_team=0).
  // bundle.batting/pitching may include all sides; filter explicitly to prevent
  // our own players or players from other teams appearing in the report.
  const allOppBatters  = (a._bundle?.batting  || []).filter(b => b.is_our_team === 0);
  const allOppPitchers = (a._bundle?.pitching || []).filter(p => p.is_our_team === 0);
  // Pitcher advanced stats (opponent)
  const pitAdvMap = {};
  for (const p of (a._ourPitchers || [])) pitAdvMap[p.player_name] = p;

  function jerseyFor(name) {
    if (!name) return null;
    if (jerseyMap[name]) return jerseyMap[name];
    const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const wanted = norm(name);
    const hit = Object.entries(jerseyMap).find(([player]) => norm(player) === wanted);
    return hit ? hit[1] : null;
  }

  function playerLabel(name) {
    const j = jerseyFor(name);
    return j ? `#${j} ${name}` : name;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // COVER PAGE
  // ─────────────────────────────────────────────────────────────────────────
  const coverBlock = [
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing:   { before: 0, after: 60 },
      children:  [new TextRun({ text: 'VOODOO SCOUT', bold: true, size: 48, color: NAVY, font: 'Arial' })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing:   { after: 60 },
      children:  [new TextRun({ text: 'Intelligence Report', size: 26, color: BLUE, font: 'Arial' })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing:   { after: 60 },
      border:    { bottom: { style: BorderStyle.SINGLE, size: 12, color: NAVY, space: 2 } },
      children:  [new TextRun({ text: '' })],
    }),
    spacer(100),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing:   { after: 60 },
      children:  [new TextRun({ text: 'Scouting Report', bold: true, size: 36, color: NAVY, font: 'Arial' })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing:   { after: 40 },
      children:  [new TextRun({ text: teamName, size: 30, color: BLUE, font: 'Arial' })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing:   { after: 40 },
      children:  [new TextRun({
        text: `Record: ${a._record?.wins ?? '?'}-${a._record?.losses ?? '?'}`,
        size: 22, color: '595959', font: 'Arial', italic: true,
      })],
    }),
    spacer(80),
  ];

  // ─────────────────────────────────────────────────────────────────────────
  // PITCHING SUMMARY TABLE (Bob Jones format)
  // ─────────────────────────────────────────────────────────────────────────
  function buildPitchingSummaryBlock() {
    // Combine box score pitching with advanced stats
    // Sort by IP descending (most used first)
    const pitchers = [...allOppPitchers].sort((a, b) => (b.total_ip || 0) - (a.total_ip || 0));

    const rows = pitchers.map((p, i) => {
      const adv  = pitAdvMap[p.player_name] || {};
      const isAlt = i % 2 === 1;
      const jersey = jerseyFor(p.player_name) ? `#${jerseyFor(p.player_name)} ` : '';
      return new TableRow({ children: [
        cell(`${jersey}${p.player_name}`, { width: 2200, bold: true, isAlt }),
        cell(String(p.games ?? '—'),              { width: 500,  align: AlignmentType.CENTER, isAlt }),
        cell(fmt(p.total_ip, 1),                  { width: 700,  align: AlignmentType.CENTER, isAlt }),
        cell(fmt(p.era, 2),                       { width: 700,  align: AlignmentType.CENTER, isAlt }),
        cell(fmt(p.whip, 2),                      { width: 700,  align: AlignmentType.CENTER, isAlt }),
        cell(fmt(adv.so_per7, 2),                 { width: 700,  align: AlignmentType.CENTER, isAlt }),
        cell(fmt(adv.bb_per7, 2),                 { width: 700,  align: AlignmentType.CENTER, isAlt }),
        cell(adv.s_pct != null ? adv.s_pct.toFixed(1) + '%' : '—', { width: 700, align: AlignmentType.CENTER, isAlt }),
      ]});
    });

    // Team totals row
    const totalIP   = allOppPitchers.reduce((s, p) => s + (p.total_ip || 0), 0);
    const totalER   = allOppPitchers.reduce((s, p) => s + (p.total_er || 0), 0);
    const totalBB   = allOppPitchers.reduce((s, p) => s + (p.total_bb || 0), 0);
    const totalH    = allOppPitchers.reduce((s, p) => s + (p.total_h  || 0), 0);
    const totalSO   = allOppPitchers.reduce((s, p) => s + (p.total_so || 0), 0);
    const teamERA   = totalIP > 0 ? (totalER / totalIP * 9) : null;
    const teamWHIP  = totalIP > 0 ? ((totalBB + totalH) / totalIP) : null;
    const teamSO7   = totalIP > 0 ? (totalSO / totalIP * 7) : null;
    const teamBB7   = totalIP > 0 ? (totalBB / totalIP * 7) : null;

    // Strike pct from all adv
    const allStrikes = (a._oppPitchers || []).reduce((s, p) => s + (p.strikes || 0), 0);
    const allPitches = (a._oppPitchers || []).reduce((s, p) => s + (p.total_pitches || 0), 0);
    const teamSpct   = allPitches > 0 ? (allStrikes / allPitches * 100) : null;
    const totalApps  = allOppPitchers.reduce((s, p) => s + (p.games || 0), 0);

    const totalsRow = new TableRow({ children: [
      cell('TEAM TOTALS', { width: 2200, bold: true, bg: LGRAY }),
      cell(String(totalApps || '—'), { width: 500,  align: AlignmentType.CENTER, bold: true, bg: LGRAY }),
      cell(fmt(totalIP, 1),          { width: 700,  align: AlignmentType.CENTER, bold: true, bg: LGRAY }),
      cell(fmt(teamERA, 2),          { width: 700,  align: AlignmentType.CENTER, bold: true, bg: LGRAY }),
      cell(fmt(teamWHIP, 2),         { width: 700,  align: AlignmentType.CENTER, bold: true, bg: LGRAY }),
      cell(fmt(teamSO7, 2),          { width: 700,  align: AlignmentType.CENTER, bold: true, bg: LGRAY }),
      cell(fmt(teamBB7, 2),          { width: 700,  align: AlignmentType.CENTER, bold: true, bg: LGRAY }),
      cell(teamSpct != null ? teamSpct.toFixed(1) + '%' : '—', { width: 700, align: AlignmentType.CENTER, bold: true, bg: LGRAY }),
    ]});

    return [
      sectionHeading('PITCHING SUMMARY'),
      new Table({
        width: { size: 9900, type: WidthType.DXA },
        columnWidths: [2200, 500, 700, 700, 700, 700, 700, 700],
        rows: [
          new TableRow({ children: [
            hCell('Player',   2200), hCell('App',  500),  hCell('IP',    700),
            hCell('ERA',      700),  hCell('WHIP', 700),  hCell('SO/7',  700),
            hCell('BB/7',     700),  hCell('S%',   700),
          ]}),
          ...rows,
          totalsRow,
        ],
      }),
      spacer(120),
    ];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HITTING SUMMARY TABLE (Bob Jones format — all batters)
  // ─────────────────────────────────────────────────────────────────────────
  function buildHittingSummaryBlock() {
    const batters = [...allOppBatters].sort((a, b) => (b.total_ab || 0) - (a.total_ab || 0));

    const rows = batters.map((b, i) => {
      const adv    = getAdv(b.player_name);
      const m      = calcBattingMetrics(b, {}, adv);
      const isAlt  = i % 2 === 1;
      const jersey = jerseyFor(b.player_name) ? `#${jerseyFor(b.player_name)} ` : '';

      return new TableRow({ children: [
        cell(`${jersey}${b.player_name}`, { width: 1600, bold: true, size: 16, isAlt }),
        cell(String(m.pa || '—'),            { width: 480, align: AlignmentType.CENTER, size: 16, isAlt }),
        cell(String(b.total_ab ?? '—'),    { width: 400, align: AlignmentType.CENTER, size: 16, isAlt }),
        cell(String(b.total_h ?? '—'),     { width: 380, align: AlignmentType.CENTER, size: 16, isAlt }),
        cell(String(b.total_so ?? '—'),    { width: 380, align: AlignmentType.CENTER, size: 16, isAlt }),
        cell(String(b.total_bb ?? '—'),    { width: 380, align: AlignmentType.CENTER, size: 16, isAlt }),
        cell(String(b.total_hbp ?? '—'),   { width: 380, align: AlignmentType.CENTER, size: 16, isAlt }),
        cell(String(b.total_hr ?? '—'),    { width: 380, align: AlignmentType.CENTER, size: 16, isAlt }),
        cell(String(m.xbh || '—'),           { width: 400, align: AlignmentType.CENTER, size: 16, isAlt }),
        cell(String(b.total_sb ?? '—'),    { width: 400, align: AlignmentType.CENTER, size: 16, isAlt }),
        cell(fmtAvg(m.avg),        { width: 460, align: AlignmentType.CENTER, size: 16, isAlt }),
        cell(fmtAvg(m.obp),        { width: 460, align: AlignmentType.CENTER, size: 16, isAlt }),
        cell(fmtAvg(m.slg),        { width: 460, align: AlignmentType.CENTER, size: 16, isAlt }),
        cell(fmtAvg(m.ops),        { width: 500, align: AlignmentType.CENTER, size: 16, isAlt }),
        cell(m.kPct != null ? m.kPct.toFixed(1)+'%' : '—', { width: 480, align: AlignmentType.CENTER, size: 16, isAlt }),
        cell(m.bbPct != null ? m.bbPct.toFixed(1)+'%' : '—', { width: 480, align: AlignmentType.CENTER, size: 16, isAlt }),
        cell(m.gbPct != null ? m.gbPct.toFixed(1)+'%' : '—', { width: 480, align: AlignmentType.CENTER, size: 16, isAlt }),
        cell(m.bunts != null ? String(m.bunts) : '—',                { width: 420, align: AlignmentType.CENTER, size: 16, isAlt }),
      ]});
    });

    // Team totals
    const totals = batters.reduce((t, b) => {
      const m = calcBattingMetrics(b, {}, getAdv(b.player_name));
      t.pa += m.pa; t.ab += m.ab; t.h += m.h; t.so += m.so; t.bb += m.bb; t.hbp += m.hbp;
      t.hr += m.hr; t.dbl += m.dbl; t.tpl += m.tpl; t.xbh += m.xbh; t.sb += m.sb; t.sac += m.sac;
      t.gb += toNum(getAdv(b.player_name).gb); t.battedBalls += toNum(getAdv(b.player_name).batted_balls);
      return t;
    }, { pa:0, ab:0, h:0, so:0, bb:0, hbp:0, hr:0, dbl:0, tpl:0, xbh:0, sb:0, sac:0, gb:0, battedBalls:0 });
    const totPA = totals.pa, totAB = totals.ab, totH = totals.h, totSO = totals.so, totBB = totals.bb, totHBP = totals.hbp;
    const totHR = totals.hr, tot2B = totals.dbl, tot3B = totals.tpl, totXBH = totals.xbh, totSB = totals.sb;
    const teamAVG = totAB > 0 ? totH / totAB : null;
    const teamOBP_d = totAB + totBB + totHBP + totals.sac;
    const teamOBP   = teamOBP_d > 0 ? (totH + totBB + totHBP) / teamOBP_d : null;
    const teamTB  = (totH - totXBH) + 2*tot2B + 3*tot3B + 4*totHR;
    const teamSLG = totAB > 0 ? teamTB / totAB : null;
    const teamOPS = (teamOBP != null && teamSLG != null) ? teamOBP + teamSLG : null;
    const teamKpct  = totPA > 0 ? totSO / totPA * 100 : null;
    const teamBBpct = totPA > 0 ? totBB / totPA * 100 : null;
    const teamGBpct = totals.battedBalls > 0 ? totals.gb / totals.battedBalls * 100 : null;

    const totRow = new TableRow({ children: [
      cell('TEAM TOTALS', { width: 1600, bold: true, bg: LGRAY, size: 16 }),
      cell(String(totPA),  { width: 480, align: AlignmentType.CENTER, bold: true, bg: LGRAY, size: 16 }),
      cell(String(totAB),  { width: 400, align: AlignmentType.CENTER, bold: true, bg: LGRAY, size: 16 }),
      cell(String(totH),   { width: 380, align: AlignmentType.CENTER, bold: true, bg: LGRAY, size: 16 }),
      cell(String(totSO),  { width: 380, align: AlignmentType.CENTER, bold: true, bg: LGRAY, size: 16 }),
      cell(String(totBB),  { width: 380, align: AlignmentType.CENTER, bold: true, bg: LGRAY, size: 16 }),
      cell(String(totHBP), { width: 380, align: AlignmentType.CENTER, bold: true, bg: LGRAY, size: 16 }),
      cell(String(totHR),  { width: 380, align: AlignmentType.CENTER, bold: true, bg: LGRAY, size: 16 }),
      cell(String(totXBH), { width: 400, align: AlignmentType.CENTER, bold: true, bg: LGRAY, size: 16 }),
      cell(String(totSB),  { width: 400, align: AlignmentType.CENTER, bold: true, bg: LGRAY, size: 16 }),
      cell(teamAVG != null ? fmtAvg(teamAVG) : '—', { width: 460, align: AlignmentType.CENTER, bold: true, bg: LGRAY, size: 16 }),
      cell(teamOBP != null ? fmtAvg(teamOBP) : '—', { width: 460, align: AlignmentType.CENTER, bold: true, bg: LGRAY, size: 16 }),
      cell(teamSLG != null ? fmtAvg(teamSLG) : '—', { width: 460, align: AlignmentType.CENTER, bold: true, bg: LGRAY, size: 16 }),
      cell(teamOPS != null ? fmtAvg(teamOPS) : '—', { width: 500, align: AlignmentType.CENTER, bold: true, bg: LGRAY, size: 16 }),
      cell(teamKpct  != null ? teamKpct.toFixed(1)+'%'  : '—', { width: 480, align: AlignmentType.CENTER, bold: true, bg: LGRAY, size: 16 }),
      cell(teamBBpct != null ? teamBBpct.toFixed(1)+'%' : '—', { width: 480, align: AlignmentType.CENTER, bold: true, bg: LGRAY, size: 16 }),
      cell(teamGBpct != null ? teamGBpct.toFixed(1)+'%' : '—', { width: 480, align: AlignmentType.CENTER, bold: true, bg: LGRAY, size: 16 }),
      cell(String(totals.sac || '—'), { width: 420, align: AlignmentType.CENTER, bold: true, bg: LGRAY, size: 16 }),
    ]});

    const colWidths = [1600,480,400,380,380,380,380,380,400,400,460,460,460,500,480,480,480,420];
    return [
      sectionHeading('HITTING SUMMARY'),
      new Table({
        width: { size: 9900, type: WidthType.DXA },
        columnWidths: colWidths,
        rows: [
          new TableRow({ children: [
            hCell('Player',1600), hCell('PA',480),  hCell('AB',400),  hCell('H',380),
            hCell('K',380),       hCell('BB',380),  hCell('HBP',380), hCell('HR',380),
            hCell('XBH',400),     hCell('SBA',400), hCell('BA',460),  hCell('OBP',460),
            hCell('SLG',460),     hCell('OPS',500), hCell('K%',480),  hCell('BB%',480),
            hCell('GB%',480),     hCell('Bunts',420),
          ]}),
          ...rows,
          totRow,
        ],
      }),
      spacer(120),
    ];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FIELDING SUMMARY TABLE
  // ─────────────────────────────────────────────────────────────────────────
  function buildFieldingSummaryBlock() {
    // Build fielding data from batting_lines raw_json position field
    // and from errors tracked in play events (if available)
    // We use position field from DB batting lines + game count
    const fieldingMap = {}; // name → { errors, positions: {pos → count} }

    // Pull from bundle batting raw (opponent batters from DB)
    for (const b of (a._bundle?.rawBattingLines || [])) {
      if (!b.player_name) continue;
      if (!fieldingMap[b.player_name]) {
        fieldingMap[b.player_name] = { errors: 0, positions: {} };
      }
      const pos = (b.position || '').replace(/\s+/g,'').toUpperCase();
      if (pos && pos !== 'DH' || pos === 'DH') {
        const posKey = pos || 'DH';
        fieldingMap[b.player_name].positions[posKey] =
          (fieldingMap[b.player_name].positions[posKey] || 0) + 1;
      }
      fieldingMap[b.player_name].errors += b.errors || 0;
    }

    // If rawBattingLines not available, fall back to bundle.batting positions
    if (Object.keys(fieldingMap).length === 0) {
      for (const b of allOppBatters) {
        if (!b.player_name) continue;
        fieldingMap[b.player_name] = {
          errors: 0,
          positions: { [b.primary_position || 'N/A']: b.games || 1 },
        };
      }
    }

    const rows = Object.entries(fieldingMap)
      .sort(([,a],[,b]) => b.errors - a.errors)
      .map(([name, data], i) => {
        const jersey = jerseyFor(name) ? `#${jerseyFor(name)} ` : '';
        const posStr = Object.entries(data.positions)
          .sort(([,a],[,b]) => b - a)
          .map(([pos, cnt]) => `${pos} (${cnt})`)
          .join(', ');
        return new TableRow({ children: [
          cell(`${jersey}${name}`, { width: 2400, bold: true, isAlt: i%2===1 }),
          cell(String(data.errors),  { width: 600,  align: AlignmentType.CENTER, isAlt: i%2===1 }),
          cell(posStr || '—',        { width: 6900, isAlt: i%2===1 }),
        ]});
      });

    if (rows.length === 0) return [];

    return [
      sectionHeading('FIELDING SUMMARY'),
      new Table({
        width: { size: 9900, type: WidthType.DXA },
        columnWidths: [2400, 600, 6900],
        rows: [
          new TableRow({ children: [
            hCell('Name', 2400), hCell('Errors', 600), hCell('Positions', 6900),
          ]}),
          ...rows,
        ],
      }),
      spacer(120),
    ];
  }

  // ─────────────────────────────────────────────────────────────────────────
  // OVERVIEW / ANALYSIS sections (unchanged from original)
  // ─────────────────────────────────────────────────────────────────────────
  const bat  = a.battingAnalysis  || {};
  const pit  = a.pitchingAnalysis || {};
  const tend = a.tendencyAnalysis || {};
  const gp   = a.gamePlan         || {};

  const overviewBlock = [
    sectionHeading('OVERVIEW'),
    bodyPara(a.overallSummary || 'No summary available.'),
    spacer(80),
    new Table({
      width: { size: 9900, type: WidthType.DXA },
      columnWidths: [2475, 2475, 2475, 2475],
      rows: [
        new TableRow({ children: [
          hCell('WINS',2475), hCell('LOSSES',2475), hCell('WIN %',2475), hCell('CONFIDENCE',2475),
        ]}),
        new TableRow({ children: [
          cell(String(a._record?.wins ?? '—'),    { width:2475, align:AlignmentType.CENTER, bold:true, size:28 }),
          cell(String(a._record?.losses ?? '—'),  { width:2475, align:AlignmentType.CENTER, bold:true, size:28 }),
          cell(a._record?.winPct != null ? fmt(a._record.winPct,3) : '—', { width:2475, align:AlignmentType.CENTER, bold:true, size:28 }),
          cell(confidence, { width:2475, align:AlignmentType.CENTER }),
        ]}),
      ],
    }),
    spacer(140),
  ];

  const battingBlock = [
    sectionHeading('BATTING ANALYSIS'),
    new Table({
      width: { size: 9900, type: WidthType.DXA },
      columnWidths: [4950, 4950],
      rows: [
        new TableRow({ children: [hCell('TEAM AVG',4950), hCell('TEAM OBP',4950)] }),
        new TableRow({ children: [
          cell(fmtAvg(a._teamStats?.avg ?? bat.teamAvg), { width:4950, align:AlignmentType.CENTER, size:28, bold:true }),
          cell(fmtAvg(a._teamStats?.obp ?? bat.teamOBP), { width:4950, align:AlignmentType.CENTER, size:28, bold:true }),
        ]}),
      ],
    }),
    spacer(100),
    subHeading('Offensive Approach'),
    bodyPara(bat.approachNotes || 'Insufficient data.'),
    spacer(60),
    subHeading('Strengths'),
    ...(bat.keyStrengths || []).map(s => bulletPara(s)),
    spacer(60),
    subHeading('Weaknesses / Vulnerabilities'),
    ...(bat.keyWeaknesses || []).map(w => bulletPara(w)),
    bodyPara(bat.vulnerabilities || '', { italic: true, color: '595959' }),
    spacer(60),
    subHeading('Hitters to Watch'),
    ...((bat.protectedHitters || []).map(h => new Table({
      width: { size: 9900, type: WidthType.DXA },
      columnWidths: [3300, 1500, 5100],
      rows: [new TableRow({ children: [
        cell(playerLabel(h.name), { width:3300, bold:true, color:NAVY }),
        cell(`THREAT: ${(h.threat||'').toUpperCase()}`, { width:1500, bold:true, color:WHITE, bg:threatColor(h.threat), align:AlignmentType.CENTER }),
        cell(h.note, { width:5100 }),
      ]})],
    }))),
    spacer(140),
  ];

  // Pitching analysis (AI narrative) + pitcher table (advanced stats)
  const advPMap = {};
  for (const p of (a._ourPitchers || [])) advPMap[p.player_name] = p;

  const pitchRows = (pit.pitchers || []).map(p => {
    const adv = advPMap[p.name] || {};
    return new TableRow({ children: [
      cell(playerLabel(p.name), { width:2000, bold:true }),
      cell(fmt(p.ip,1),         { width:500,  align:AlignmentType.CENTER }),
      cell(fmt(p.era,2),        { width:600,  align:AlignmentType.CENTER }),
      cell(fmt(p.whip,3),       { width:600,  align:AlignmentType.CENTER }),
      cell(fmt(p.so_per7 ?? adv.so_per7,2), { width:600, align:AlignmentType.CENTER }),
      cell(fmt(p.bb_per7 ?? adv.bb_per7,2), { width:600, align:AlignmentType.CENTER }),
      cell(adv.s_pct != null ? adv.s_pct.toFixed(1)+'%' : '—', { width:600, align:AlignmentType.CENTER }),
      cell((p.threat||'').toUpperCase(), { width:700, bold:true, color:WHITE, bg:threatColor(p.threat), align:AlignmentType.CENTER }),
      cell(p.note, { width:1600 }),
    ]});
  });

  const pitchingBlock = [
    sectionHeading('PITCHING ANALYSIS'),
    labelValue('Staff Depth', (pit.staffDepth||'unknown').toUpperCase()),
    bodyPara(pit.staffNotes || 'Insufficient data.'),
    spacer(60),
    subHeading('Pitching Staff'),
    ...(pitchRows.length ? [new Table({
      width: { size: 9900, type: WidthType.DXA },
      columnWidths: [2000,500,600,600,600,600,600,700,1600],
      rows: [
        new TableRow({ children: [
          hCell('PITCHER',2000), hCell('IP',500), hCell('ERA',600),
          hCell('WHIP',600),     hCell('SO/7',600), hCell('BB/7',600),
          hCell('S%',600),       hCell('THREAT',700), hCell('NOTE',1600),
        ]}),
        ...pitchRows,
      ],
    })] : [bodyPara('No pitching data available.')]),
    spacer(60),
    subHeading('Fatigue / Overuse Risk'),
    bodyPara(pit.fatigueRisk || 'Unknown.'),
    spacer(60),
    subHeading('Key Strengths'),
    ...(pit.keyStrengths || []).map(s => bulletPara(s)),
    subHeading('Key Weaknesses'),
    ...(pit.keyWeaknesses || []).map(w => bulletPara(w)),
    spacer(140),
  ];

  const tendencyBlock = [
    sectionHeading('TENDENCIES'),
    new Table({
      width: { size: 9900, type: WidthType.DXA },
      columnWidths: [1980,1980,1980,1980,1980],
      rows: [
        new TableRow({ children: [
          hCell('STYLE',1980), hCell('GROUND BALLS',1980), hCell('K RATE',1980),
          hCell('WALK RATE',1980), hCell('SB ACTIVITY',1980),
        ]}),
        new TableRow({ children: [
          cell((tend.offensiveStyle||'?').toUpperCase(),    { width:1980, align:AlignmentType.CENTER, bold:true }),
          cell((tend.groundBallTendency||'?').toUpperCase(),{ width:1980, align:AlignmentType.CENTER }),
          cell((tend.strikeoutRate||'?').toUpperCase(),     { width:1980, align:AlignmentType.CENTER }),
          cell((tend.walkRate||'?').toUpperCase(),          { width:1980, align:AlignmentType.CENTER }),
          cell((tend.stolenBaseActivity||'?').toUpperCase(),{ width:1980, align:AlignmentType.CENTER }),
        ]}),
      ],
    }),
    spacer(100),
    subHeading('Key Patterns'),
    ...(tend.keyPatterns || []).map(p => bulletPara(p)),
    spacer(140),
  ];

  const gamePlanBlock = [
    sectionHeading('GAME PLAN'),
    subHeading('Pitching Strategy'),    bodyPara(gp.pitchingStrategy   || 'Insufficient data.'), spacer(60),
    subHeading('Defensive Alignment'),  bodyPara(gp.defensiveAlignment  || 'Insufficient data.'), spacer(60),
    subHeading('Offensive Approach'),   bodyPara(gp.offensiveApproach   || 'Insufficient data.'), spacer(60),
    subHeading('Baserunning'),          bodyPara(gp.baserunning          || 'Insufficient data.'), spacer(60),
    subHeading('Key Matchups'),         ...(gp.keyMatchups   || []).map(m => bulletPara(m)), spacer(60),
    subHeading('Things to Avoid'),      ...(gp.thingsToAvoid || []).map(t => bulletPara(t)),
    spacer(140),
  ];

  // ─────────────────────────────────────────────────────────────────────────
  // PLAYER BREAKDOWN SUMMARY TABLE
  // ─────────────────────────────────────────────────────────────────────────
  const players = a.playerBreakdowns || [];

  const playerSummaryRows = players.map((p, i) => {
    const bb = bundleBatMap[p.name] || {};
    const bp = bundlePitMap[p.name] || {};
    const m = calcBattingMetrics(bb, p.stats || {}, getAdv(p.name));
    return new TableRow({ children: [
      cell(playerLabel(p.name),        { width:2200, bold:true, color:NAVY, isAlt:i%2===1 }),
      cell(fmtAvg(m.avg),             { width:700, align:AlignmentType.CENTER, isAlt:i%2===1 }),
      cell(fmtAvg(m.obp),             { width:700, align:AlignmentType.CENTER, isAlt:i%2===1 }),
      cell(String(m.hr || p.stats?.hr || '—'),  { width:560, align:AlignmentType.CENTER, isAlt:i%2===1 }),
      cell(String(bb.total_rbi ?? p.stats?.rbi ?? '—'),{ width:560, align:AlignmentType.CENTER, isAlt:i%2===1 }),
      cell(fmt(bp.era ?? p.stats?.era, 2),              { width:700, align:AlignmentType.CENTER, isAlt:i%2===1 }),
      cell(p.scoutingNote || '',        { width:4480, size:16, isAlt:i%2===1 }),
    ]});
  });

  const playerSummaryBlock = [
    sectionHeading('PLAYER BREAKDOWNS'),
    ...(playerSummaryRows.length ? [new Table({
      width: { size: 9900, type: WidthType.DXA },
      columnWidths: [2200,700,700,560,560,700,4480],
      rows: [
        new TableRow({ children: [
          hCell('PLAYER',2200), hCell('AVG',700), hCell('OBP',700),
          hCell('HR',560),      hCell('RBI',560), hCell('ERA',700), hCell('SCOUT NOTE',4480),
        ]}),
        ...playerSummaryRows,
      ],
    })] : [bodyPara('No individual player data available.')]),
    spacer(100),
    bodyPara(`Data confidence: ${confidence}. ${a.reportMeta?.confidenceNote || ''}`, { italic:true, color:'595959' }),
    spacer(140),
  ];

  // ─────────────────────────────────────────────────────────────────────────
  // PER-PLAYER PAGES  — Fan chart LEFT, Stats + Swing Decisions RIGHT
  //                     Scout note full-width below
  // ─────────────────────────────────────────────────────────────────────────
  function buildSwingTable(sd) {
    if (!sd) return [bodyPara('Swing decision data not available.', { italic:true, color:'595959' })];
    const ALL_COUNTS = ['0-0','0-1','0-2','1-0','1-1','1-2','2-0','2-1','2-2','3-0','3-1','3-2'];
    const dataRows = ALL_COUNTS.map((count, i) => {
      const d = sd[count] || { swing_pct:0, take_k_pct:0, n:0 };
      return new TableRow({ children: [
        cell(count,                 { width:600,  align:AlignmentType.CENTER, bold:true, size:17, isAlt:i%2===1 }),
        cell(d.swing_pct   + '%',   { width:900,  align:AlignmentType.CENTER, size:17, isAlt:i%2===1 }),
        cell(d.take_k_pct  + '%',   { width:900,  align:AlignmentType.CENTER, size:17, isAlt:i%2===1 }),
        cell(String(d.n),           { width:600,  align:AlignmentType.CENTER, size:17, isAlt:i%2===1 }),
      ]});
    });
    return [new Table({
      width: { size: 3000, type: WidthType.DXA },
      columnWidths: [600,900,900,600],
      rows: [
        new TableRow({ children: [
          hCell('Count',600), hCell('Swing %',900), hCell('Take K %',900), hCell('n',600),
        ]}),
        ...dataRows,
      ],
    })];
  }

  // 9-col stats table (narrow, fits right column)
  function buildStatsTable(realBat, player) {
    const adv = getAdv(player.name);
    const m = calcBattingMetrics(realBat, player.stats || {}, adv);
    const cols1 = [
      ['PA', String(m.pa || '—')],['AB',String(m.ab || '—')],['H',String(m.h || '—')],
      ['K', String(m.so || '—')],['BB',String(m.bb || '—')],
    ];
    const cols2 = [
      ['HR',String(m.hr || player.stats?.hr || '—')],
      ['XBH',String(m.xbh || '—')],
      ['SBA',String(m.sb || '—')],
      ['HBP',String(m.hbp || '—')],
    ];
    const W5 = 900, W4 = 1125;
    return [
      new Table({
        width: { size: 4500, type: WidthType.DXA },
        columnWidths: [W5,W5,W5,W5,W5],
        rows: [
          new TableRow({ children: cols1.map(([l]) => hCell(l,W5)) }),
          new TableRow({ children: cols1.map(([,v],i) => cell(v,{ width:W5, align:AlignmentType.CENTER, size:20, bold:true, isAlt:false })) }),
        ],
      }),
      spacer(40),
      new Table({
        width: { size: 4500, type: WidthType.DXA },
        columnWidths: [W4,W4,W4,W4],
        rows: [
          new TableRow({ children: cols2.map(([l]) => hCell(l,W4)) }),
          new TableRow({ children: cols2.map(([,v]) => cell(v,{ width:W4, align:AlignmentType.CENTER, size:20, bold:true })) }),
        ],
      }),
      spacer(40),
      // BA / OBP / SLG / OPS
      new Table({
        width: { size: 4500, type: WidthType.DXA },
        columnWidths: [1125,1125,1125,1125],
        rows: [
          new TableRow({ children: ['BA','OBP','SLG','OPS'].map(l => hCell(l,1125)) }),
          new TableRow({ children: [
            cell(fmtAvg(m.avg),{width:1125,align:AlignmentType.CENTER,size:20,bold:true}),
            cell(fmtAvg(m.obp),{width:1125,align:AlignmentType.CENTER,size:20,bold:true}),
            cell(fmtAvg(m.slg),{width:1125,align:AlignmentType.CENTER,size:20,bold:true}),
            cell(fmtAvg(m.ops),{width:1125,align:AlignmentType.CENTER,size:20,bold:true}),
          ]}),
        ],
      }),
      spacer(40),
      // K% / BB% / GB%
      new Table({
        width: { size: 4500, type: WidthType.DXA },
        columnWidths: [1500,1500,1500],
        rows: [
          new TableRow({ children: ['K%','BB%','GB%'].map(l => hCell(l,1500)) }),
          new TableRow({ children: [
            cell(m.kPct != null ? m.kPct.toFixed(1)+'%' : '—', {width:1500,align:AlignmentType.CENTER,size:20,bold:true}),
            cell(m.bbPct != null ? m.bbPct.toFixed(1)+'%' : '—',{width:1500,align:AlignmentType.CENTER,size:20,bold:true}),
            cell(m.gbPct != null ? m.gbPct.toFixed(1)+'%' : '—',{width:1500,align:AlignmentType.CENTER,size:20,bold:true}),
          ]}),
        ],
      }),
    ];
  }

  console.log('[buildDocx] per-player pages, count:', players.length);

  const playerPages = players.flatMap(player => {
    const adv     = getAdv(player.name);
    const sd      = adv.swingDecisions || (adv.swing_decisions
      ? (() => { try { return JSON.parse(adv.swing_decisions); } catch { return null; } })()
      : null);
    const realBat = bundleBatMap[player.name] || Object.values(bundleBatMap).find(b => {
      const norm = s => s.toLowerCase().replace(/[^a-z ]/g,'').trim();
      return norm(b.player_name) === norm(player.name);
    }) || {};

    // Fan spray chart from adv stats zone percentages
    const sprayPct = {
      LF: adv.spray_lf_pct ?? 0,
      CF: adv.spray_cf_pct ?? 0,
      RF: adv.spray_rf_pct ?? 0,
      '3B': adv.spray_3b_pct ?? 0,
      SS:   adv.spray_ss_pct ?? 0,
      '2B': adv.spray_2b_pct ?? 0,
      '1B': adv.spray_1b_pct ?? 0,
      P:    adv.spray_pc_pct ?? 0,
    };
    const hasSpraryData = Object.values(sprayPct).some(v => v > 0);

    // Get spray PNG — prefer PG-sourced image, fall back to GC zone chart
    const pgSprayPng = analysis._sprayImages?.[player.name] || null;
    const gcSprayPng = hasSpraryData ? analysis._gcSprayImages?.[player.name] || null : null;
    const sprayPng   = pgSprayPng || gcSprayPng;

    // Header
    const pageHeader = (() => {
      return new Paragraph({
        pageBreakBefore: true,
        heading: HeadingLevel.HEADING_1,
        spacing: { before:0, after:120 },
        children: [new TextRun({ text: playerLabel(player.name), bold:true, size:32, color:NAVY, font:'Arial' })],
      });
    })();

    // Build two-column layout using a table:
    //   Left col  (4400 dxa ≈ 3.05"): spray chart image
    //   Right col (5500 dxa ≈ 3.82"): stats tables + swing decisions
    const LEFT  = 4400;
    const RIGHT = 5500;

    const leftContent = [];

    if (sprayPng) {
      leftContent.push(new Paragraph({
        spacing: { after:60 },
        children: [new ImageRun({
          data: sprayPng,
          transformation: { width: 220, height: 191 },
        })],
      }));
    } else if (hasSpraryData) {
      // Spray zone % table as fallback
      leftContent.push(subHeading('Spray Zones'));
      const zoneLabels = ['LF','CF','RF','3B','SS','2B','1B','P/C'];
      const zoneVals   = [
        sprayPct.LF, sprayPct.CF, sprayPct.RF,
        sprayPct['3B'], sprayPct.SS, sprayPct['2B'], sprayPct['1B'], sprayPct.P,
      ];
      leftContent.push(new Table({
        width: { size: LEFT-200, type: WidthType.DXA },
        columnWidths: Array(8).fill(Math.floor((LEFT-200)/8)),
        rows: [
          new TableRow({ children: zoneLabels.map(l => hCell(l, Math.floor((LEFT-200)/8))) }),
          new TableRow({ children: zoneVals.map(v => cell(v != null ? v.toFixed(0)+'%' : '—', { width: Math.floor((LEFT-200)/8), align: AlignmentType.CENTER })) }),
        ],
      }));
    } else {
      leftContent.push(bodyPara('No spray chart data available.', { italic:true, color:'595959' }));
    }

    const rightContent = [
      subHeading('Stats'),
      ...buildStatsTable(realBat, player),
      spacer(80),
      subHeading('Swing Decisions'),
      ...buildSwingTable(sd),
    ];

    // Wrap left/right in a two-cell table row (no visible border)
    function wrapInCell(children, width) {
      return new TableCell({
        borders: noBorders,
        width:   { size: width, type: WidthType.DXA },
        margins: { top:0, bottom:0, left:0, right:160 },
        children,
      });
    }

    const twoColTable = new Table({
      width:        { size: 9900, type: WidthType.DXA },
      columnWidths: [LEFT, RIGHT],
      rows: [new TableRow({ children: [
        wrapInCell(leftContent,  LEFT),
        wrapInCell(rightContent, RIGHT),
      ]})],
      borders: { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder, insideH: noBorder, insideV: noBorder },
    });

    // Scout note full-width below
    const scoutNote = player.scoutingNote
      ? [spacer(80), bodyPara(player.scoutingNote)]
      : [];

    return [pageHeader, twoColTable, ...scoutNote, spacer(140)];
  });

  // ─────────────────────────────────────────────────────────────────────────
  // GAME CONDITIONS + PITCHSMART AVAILABILITY
  // ─────────────────────────────────────────────────────────────────────────
  function buildGameConditionsBlock() {
    const wx = a.weatherAndConditions || null;
    const ps = a._pitchSmartEligibility || null;
    const ctx = a._gameContext || {};
    const hasWeather = wx && (wx.location || wx.forecast || wx.fieldConditions || wx.grassFieldReport || wx.turfFieldReport || wx.strategicNotes);
    const hasPitchSmart = ps && Array.isArray(ps.pitchers) && ps.pitchers.length > 0;

    // Always render this section — pitcher availability is critical coaching info
    // even when no one pitched recently (shows "all eligible") and even without weather.

    const out = [sectionHeading('GAME CONDITIONS & PITCHER AVAILABILITY')];

    if (hasWeather || ctx.gameLocation) {
      out.push(subHeading('Weather / Field Conditions'));
      out.push(labelValue('Location', wx?.location || ctx.gameLocation || '—'));
      out.push(labelValue('Game Date', wx?.gameDate || ctx.gameDate || '—'));

      const forecast = Array.isArray(wx?.forecast) ? wx.forecast : [];
      if (forecast.length) {
        out.push(new Table({
          width: { size: 9900, type: WidthType.DXA },
          columnWidths: [1700,1200,1200,4200,1600],
          rows: [
            new TableRow({ children: [hCell('DATE',1700), hCell('HIGH',1200), hCell('LOW',1200), hCell('CONDITIONS',4200), hCell('PRECIP',1600)] }),
            ...forecast.slice(0,5).map((f, i) => new TableRow({ children: [
              cell(f.date || '—', { width:1700, isAlt:i%2===1 }),
              cell(f.high ?? '—', { width:1200, align:AlignmentType.CENTER, isAlt:i%2===1 }),
              cell(f.low ?? '—', { width:1200, align:AlignmentType.CENTER, isAlt:i%2===1 }),
              cell(f.conditions || '—', { width:4200, isAlt:i%2===1 }),
              cell(f.precipPct != null ? `${f.precipPct}%` : '—', { width:1600, align:AlignmentType.CENTER, isAlt:i%2===1 }),
            ] })),
          ],
        }));
      }

      if (wx?.gameDayWind) {
        out.push(labelValue('Wind', `${wx.gameDayWind.speed || '—'} ${wx.gameDayWind.direction || ''}${wx.gameDayWind.note ? ` — ${wx.gameDayWind.note}` : ''}`));
      }
      if (wx?.fieldType) out.push(labelValue('Expected / Primary Field Type', wx.fieldType));
      if (wx?.fieldConditions) out.push(bodyPara(wx.fieldConditions));
      if (wx?.grassFieldReport) {
        out.push(subHeading('Grass Field Impact'));
        out.push(bodyPara(wx.grassFieldReport));
      }
      if (wx?.turfFieldReport) {
        out.push(subHeading('Turf Field Impact'));
        out.push(bodyPara(wx.turfFieldReport));
      }
      if (wx?.strategicNotes) out.push(bodyPara(wx.strategicNotes));
      if (!hasWeather && ctx.gameLocation) {
        out.push(bodyPara('Weather was requested, but the analysis did not return a weather block. Re-run the report with GAME_LOCATION and GAME_DATE set, or use the dashboard location/date fields.', { italic:true, color:'595959' }));
      }
      out.push(spacer(100));
    }

    const psHeadingLabel = (hasPitchSmart && ps.lookbackDates && ps.lookbackDates.length)
      ? 'PitchSmart — Last 2 Game Dates Scouted: ' + ps.lookbackDates.join(' & ')
      : 'PitchSmart — Pitcher Availability';
    out.push(subHeading(psHeadingLabel));
    if (hasPitchSmart) {
      out.push(labelValue('Your Game Date', ps.referenceDate || ctx.gameDate || '—'));
      out.push(labelValue('Age Group', `${ps.ageGroup || '14'}U (${ps.psGroup || '13-14'} PitchSmart group)`));
      out.push(labelValue('PitchSmart Rules (13-14U)', '1-20 pitches = 0 rest days | 21-35 = 1 day | 36-50 = 2 days | 51-65 = 3 days | 66+ = 4 days'));
      const psDetailRows = [];
      ps.pitchers.forEach((p, pidx) => {
        const isAlt = pidx % 2 === 1;
        const statusColor = p.isEligible ? '375623' : 'C00000';
        const statusText  = p.isEligible ? 'ELIGIBLE' : 'NOT ELIGIBLE';
        const gamesSorted = (p.games || []).slice().sort((ga, gb) => ga.date < gb.date ? -1 : 1);
        // Summary row: pitcher name | cumulative summary | rest required | eligible date | status
        psDetailRows.push(new TableRow({ children: [
          cell(playerLabel(p.name), { width:2000, bold:true, isAlt }),
          cell('Total: ' + p.pitches + ' pitches across ' + gamesSorted.length + ' outing' + (gamesSorted.length===1?'':'s'), { width:2800, bold:true, isAlt }),
          cell(p.restNeeded + ' day' + (p.restNeeded===1?'':'s') + ' req. / ' + (p.daysSince ?? '?') + 'd elapsed', { width:1800, align:AlignmentType.CENTER, isAlt }),
          cell(p.eligibleDate || 'Now', { width:1600, align:AlignmentType.CENTER, isAlt }),
          cell(statusText, { width:1700, align:AlignmentType.CENTER, bold:true, color:statusColor, isAlt }),
        ] }));
        // One detail row per outing
        gamesSorted.forEach(g => {
          psDetailRows.push(new TableRow({ children: [
            cell('', { width:2000, isAlt }),
            cell('  → ' + g.date + '  vs.  ' + (g.opponent || '?'), { width:2800, isAlt, color:'595959' }),
            cell(g.pitches + ' pitches (' + (g.ip || '?') + ' IP)', { width:1800, align:AlignmentType.CENTER, isAlt, color:'595959' }),
            cell('', { width:1600, isAlt }),
            cell('', { width:1700, isAlt }),
          ] }));
        });
      });
      out.push(new Table({
        width: { size: 9900, type: WidthType.DXA },
        columnWidths: [2000,2800,1800,1600,1700],
        rows: [
          new TableRow({ children: [
            hCell('PITCHER',2000), hCell('CUMULATIVE OUTINGS',2800),
            hCell('REST REQUIRED',1800), hCell('ELIGIBLE DATE',1600), hCell('STATUS',1700),
          ] }),
          ...psDetailRows,
        ],
      }));
    } else {
      out.push(bodyPara('No pitching lines were found for this team in the database. All pitchers are presumed eligible based on available data.', { italic:true, color:'595959' }));
    }

    // ── Active Roster Block (docx) ──
    if (activeSet.size > 0) {
      out.push(subHeading('Active Roster (Last ' + arWindow + '/' + arTotal + ' Scouted Games)'));
      out.push(bodyPara(
        'Players below appeared in at least 1 of the last ' + arWindow + ' scouted games. ' +
        'Players NOT listed had zero appearances in that window and may be injured, inactive, or released. ' +
        'Roster was filtered to ' + activeSet.size + ' active players.',
        { italic: true, color: '595959' }
      ));
      out.push(bodyPara([...activeSet].sort().join('   ·   ')));
    }

    out.push(spacer(140));
    return out;
  }

  const gameConditionsBlock = buildGameConditionsBlock();

  // ─────────────────────────────────────────────────────────────────────────
  // ASSEMBLE DOCUMENT
  // ─────────────────────────────────────────────────────────────────────────
  const doc = new Document({
    numbering: {
      config: [{
        reference: 'bullets',
        levels: [{
          level: 0, format: LevelFormat.BULLET, text: '•',
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      }],
    },
    styles: {
      default: { document: { run: { font:'Arial', size:18 } } },
      paragraphStyles: [
        { id:'Heading1', name:'Heading 1', basedOn:'Normal', next:'Normal', quickFormat:true,
          run:{ size:26, bold:true, font:'Arial', color:NAVY },
          paragraph:{ spacing:{ before:240, after:100 }, outlineLevel:0 } },
        { id:'Heading2', name:'Heading 2', basedOn:'Normal', next:'Normal', quickFormat:true,
          run:{ size:20, bold:true, font:'Arial', color:BLUE },
          paragraph:{ spacing:{ before:140, after:60 }, outlineLevel:1 } },
      ],
    },
    sections: [{
      properties: {
        page: {
          size:   { width:12240, height:15840 },
          margin: { top:900, right:900, bottom:900, left:900 },
        },
      },
      headers: {
        default: new Header({
          children: [new Paragraph({
            spacing: { after:50 },
            border:  { bottom:{ style:BorderStyle.SINGLE, size:6, color:BLUE, space:1 } },
            children: [
              new TextRun({ text:`VOODOO SCOUT  |  ${teamName}`, bold:true, size:16, color:NAVY, font:'Arial' }),
              new TextRun({ text:`\t${generated}`, size:16, color:'595959', font:'Arial' }),
            ],
            tabStops: [{ type:TabStopType.RIGHT, position:TabStopPosition.MAX }],
          })],
        }),
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            spacing: { before:50 },
            border:  { top:{ style:BorderStyle.SINGLE, size:6, color:BLUE, space:1 } },
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ text:'CONFIDENTIAL — For coaching staff use only  |  Page ', size:16, color:'595959', font:'Arial' }),
              new TextRun({ children:[PageNumber.CURRENT], size:16, color:'595959', font:'Arial' }),
            ],
          })],
        }),
      },
      children: [
        // Cover
        ...coverBlock,
        // Game context requested from dashboard
        ...gameConditionsBlock,
        // Summary tables (Bob Jones pages 2-3)
        ...buildPitchingSummaryBlock(),
        ...buildHittingSummaryBlock(),
        ...buildFieldingSummaryBlock(),
        // AI analysis sections
        ...overviewBlock,
        ...battingBlock,
        ...pitchingBlock,
        ...tendencyBlock,
        ...gamePlanBlock,
        // Player summary + per-player detail pages
        ...playerSummaryBlock,
        ...playerPages,
      ],
    }],
  });

  console.log('[report] Building document...');
  const buffer = await Packer.toBuffer(doc);
  fs.writeFileSync(outputPath, buffer);
  console.log(`[report] Word document saved: ${outputPath}`);
  return outputPath;
}

// ─── PDF via HTML + Playwright ────────────────────────────────────────────────

function buildReportHtml(analysis) {
  const a          = analysis;
  const teamName   = a.reportMeta?.teamName || 'Unknown Team';
  const games      = a.reportMeta?.gamesAnalyzed ?? 0;
  const confidence = confidenceBadge(a.reportMeta?.dataConfidence);
  const generated  = a._generatedAt
    ? new Date(a._generatedAt).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })
    : new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
  const bat  = a.battingAnalysis  || {};
  const pit  = a.pitchingAnalysis || {};
  const tend = a.tendencyAnalysis || {};
  const gp   = a.gamePlan         || {};
  const players = a.playerBreakdowns || [];

  const jerseyMap   = {
    ...(a._pgData?.jerseyMap || {}),
    ...(a._bundle?.jerseyMap || {}),
  };
  const _arH       = a._bundle?.activeRoster || {};
  const activeSetH = _arH.players instanceof Set ? _arH.players : new Set(_arH.players || []);
  const arWindowH  = _arH.gameCount ?? 0;
  const arTotalH   = _arH.totalGamesWindow ?? 10;
  const sprayImages = a._sprayImages || {};
  const gcSprayMap  = a._gcSprayImages || {};

  const bundleBatMap = {};
  for (const b of (a._bundle?.batting  || [])) bundleBatMap[b.player_name] = b;
  const bundlePitMap = {};
  for (const p of (a._bundle?.pitching || [])) bundlePitMap[p.player_name] = p;

  const advPlayerMap = {};
  for (const p of (a._playerAdvanced || [])) advPlayerMap[p.player_name] = p;
  function getAdv(name) {
    if (advPlayerMap[name]) return advPlayerMap[name];
    const norm = n => n.toLowerCase().replace(/[^a-z ]/g,'').trim();
    return Object.values(advPlayerMap).find(p => norm(p.player_name) === norm(name)) || {};
  }

  const allOppBatters  = (a._bundle?.batting  || []);
  const allOppPitchers = (a._bundle?.pitching || []);
  const pitAdvMap = {};
  for (const p of (a._ourPitchers || [])) pitAdvMap[p.player_name] = p;

  function jerseyFor(name) {
    if (!name) return null;
    if (jerseyMap[name]) return jerseyMap[name];
    const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const wanted = norm(name);
    const hit = Object.entries(jerseyMap).find(([player]) => norm(player) === wanted);
    return hit ? hit[1] : null;
  }

  function playerLabel(name) {
    const j = jerseyFor(name);
    return j ? `#${j} ${name}` : name;
  }
  function threatBadge(level) {
    const colors = { high:'#C00000', medium:'#E36C09', low:'#375623' };
    return `<span style="background:${colors[level]||'#666'};color:white;padding:2px 8px;border-radius:3px;font-size:10px;font-weight:bold">${(level||'').toUpperCase()}</span>`;
  }
  function bullets(arr) {
    if (!arr || !arr.length) return '<p style="color:#888;font-style:italic">None identified.</p>';
    return '<ul>' + arr.map(i => `<li>${i}</li>`).join('') + '</ul>';
  }
  function fmtH(v, d=3) { return fmt(v, d); }
  function esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildConditionsHtml() {
    const wx = a.weatherAndConditions || null;
    const ps = a._pitchSmartEligibility || null;
    const ctx = a._gameContext || {};
    const hasWeather = wx && (wx.location || wx.forecast || wx.fieldConditions || wx.grassFieldReport || wx.turfFieldReport || wx.strategicNotes);
    const hasPitchSmart = ps && Array.isArray(ps.pitchers) && ps.pitchers.length > 0;

    // Always render — pitcher availability is critical even with no recent games or weather.

    const forecastRows = Array.isArray(wx?.forecast) && wx.forecast.length
      ? wx.forecast.slice(0,5).map(f => `<tr>
          <td>${esc(f.date || '—')}</td>
          <td>${esc(f.high ?? '—')}</td>
          <td>${esc(f.low ?? '—')}</td>
          <td>${esc(f.conditions || '—')}</td>
          <td>${f.precipPct != null ? esc(f.precipPct) + '%' : '—'}</td>
        </tr>`).join('')
      : '';

    const wind = wx?.gameDayWind
      ? `<p><strong>Wind:</strong> ${esc(wx.gameDayWind.speed || '—')} ${esc(wx.gameDayWind.direction || '')}${wx.gameDayWind.note ? ' — ' + esc(wx.gameDayWind.note) : ''}</p>`
      : '';

    const weatherHtml = (hasWeather || ctx.gameLocation) ? `
      <h4 class="sub">Weather / Field Conditions</h4>
      <p><strong>Location:</strong> ${esc(wx?.location || ctx.gameLocation || '—')} &nbsp; <strong>Game Date:</strong> ${esc(wx?.gameDate || ctx.gameDate || '—')}</p>
      ${forecastRows ? `<table><thead><tr><th>Date</th><th>High</th><th>Low</th><th>Conditions</th><th>Precip</th></tr></thead><tbody>${forecastRows}</tbody></table>` : ''}
      ${wind}
      ${wx?.fieldType ? `<p><strong>Expected / Primary Field Type:</strong> ${esc(wx.fieldType)}</p>` : ''}
      ${wx?.fieldConditions ? `<p>${esc(wx.fieldConditions)}</p>` : ''}
      ${wx?.grassFieldReport ? `<h4 class="sub">Grass Field Impact</h4><p>${esc(wx.grassFieldReport)}</p>` : ''}
      ${wx?.turfFieldReport ? `<h4 class="sub">Turf Field Impact</h4><p>${esc(wx.turfFieldReport)}</p>` : ''}
      ${wx?.strategicNotes ? `<p>${esc(wx.strategicNotes)}</p>` : ''}
      ${!hasWeather && ctx.gameLocation ? '<p class="note-italic">Weather was requested, but the analysis did not return a weather block. Re-run the report with location/date populated.</p>' : ''}
    ` : '';

    const psRows = hasPitchSmart
      ? ps.pitchers.map(p => {
          const gamesSorted = (p.games || []).slice().sort((ga, gb) => ga.date < gb.date ? -1 : 1);
          const detailRows = gamesSorted.map(g =>
            '<tr class="ps-detail-row"><td></td>' +
            '<td colspan="2" style="padding-left:22px;color:#666;font-size:0.88em">' +
              '\u2192 ' + esc(g.date) + ' &nbsp;vs.&nbsp; ' + esc(g.opponent || '?') +
            '</td>' +
            '<td style="text-align:center;color:#666;font-size:0.88em">' + esc(g.pitches) + ' <span style="color:#999">(' + esc(g.ip || '?') + ' IP)</span></td>' +
            '<td colspan="3"></td></tr>'
          ).join('');
          return '<tr>' +
            '<td><strong>' + esc(playerLabel(p.name)) + '</strong></td>' +
            '<td>' + esc(p.mostRecentGameDate || '—') + '</td>' +
            '<td>' + esc(p.mostRecentOpponent || '—') + '</td>' +
            '<td style="text-align:center"><strong>' + esc(p.pitches ?? '—') + '</strong></td>' +
            '<td style="text-align:center">' + esc(p.restNeeded ?? 0) + ' day' + (p.restNeeded === 1 ? '' : 's') + ' req. / ' + (p.daysSince ?? '?') + 'd elapsed</td>' +
            '<td style="text-align:center">' + esc(p.eligibleDate || 'Now') + '</td>' +
            '<td style="text-align:center"><strong style="color:' + (p.isEligible ? '#375623' : '#C00000') + '">' + (p.isEligible ? 'ELIGIBLE' : 'NOT ELIGIBLE') + '</strong></td>' +
            '</tr>' + detailRows;
        }).join('')
      : '';

    const pitchSmartHtml = `
      <h4 class="sub">${hasPitchSmart && ps.lookbackDates && ps.lookbackDates.length
        ? 'PitchSmart &mdash; Last 2 Game Dates: ' + esc(ps.lookbackDates.join(' &amp; '))
        : 'PitchSmart &mdash; Pitcher Availability'
      }</h4>
      ${hasPitchSmart ? '<p><strong>Reference Date:</strong> ' + esc(ps.referenceDate || ctx.gameDate || '—') + ' &nbsp; <strong>Age Group:</strong> ' + esc(ps.ageGroup || '14') + 'U (' + esc(ps.psGroup || '13-14') + ')</p><p style="font-size:0.82em;color:#555;margin:4px 0 8px"><strong>PitchSmart (13-14U):</strong> 1–20 pitches = 0 rest days &nbsp;|&nbsp; 21–35 = 1 day &nbsp;|&nbsp; 36–50 = 2 days &nbsp;|&nbsp; 51–65 = 3 days &nbsp;|&nbsp; 66+ = 4 days</p><table><thead><tr><th style="text-align:left">Pitcher</th><th>Last Pitched</th><th>Last Opponent</th><th>Total Pitches</th><th>Rest Req.</th><th>Eligible Date</th><th>Status</th></tr></thead><tbody>' + psRows + '</tbody></table>'
      : '<p class="note-italic">No pitching lines were found for this team in the database. All pitchers are presumed eligible based on available data.</p>'}
    `;

    const activeRosterHtml = activeSetH.size > 0
      ? '<h4 class="sub">Active Roster — Last ' + arWindowH + '/' + arTotalH + ' Scouted Games</h4>' +
        '<p class="note-italic">Players below appeared in at least 1 of the last ' + arWindowH + ' scouted games and are assumed to be active for your matchup. ' +
        'Players <strong>not</strong> listed had zero appearances in that window and may be injured, inactive, or released.</p>' +
        '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px">' +
          [...activeSetH].sort().map(name =>
            '<span style="background:#1a3a5c;color:#fff;border-radius:4px;padding:3px 10px;font-size:0.85em;font-weight:600">' + esc(playerLabel(name)) + '</span>'
          ).join('') +
        '</div>'
      : '';

    return `
      <div class="page-break"></div>
      <h3 class="section">Game Conditions & Pitcher Availability</h3>
      ${weatherHtml}
      ${pitchSmartHtml}
      ${activeRosterHtml}
    `;
  }

  const conditionsHtml = buildConditionsHtml();

  // ── Pitching Summary ──
  const pitSummaryRows = [...allOppPitchers]
    .sort((a,b) => (b.total_ip||0)-(a.total_ip||0))
    .map(p => {
      const adv = pitAdvMap[p.player_name] || {};
      return `<tr>
        <td><strong>${playerLabel(p.player_name)}</strong></td>
        <td>${p.games??'—'}</td>
        <td>${fmtH(p.total_ip,1)}</td>
        <td>${fmtH(p.era,2)}</td>
        <td>${fmtH(p.whip,2)}</td>
        <td>${fmtH(adv.so_per7,2)}</td>
        <td>${fmtH(adv.bb_per7,2)}</td>
        <td>${adv.s_pct!=null ? adv.s_pct.toFixed(1)+'%' : '—'}</td>
      </tr>`;
    }).join('');

  // ── Hitting Summary ──
  const hitSummaryRows = [...allOppBatters]
    .sort((a,b) => (b.total_ab||0)-(a.total_ab||0))
    .map(b => {
      const adv = getAdv(b.player_name);
      const m = calcBattingMetrics(b, {}, adv);
      return `<tr>
        <td><strong>${playerLabel(b.player_name)}</strong></td>
        <td>${m.pa||'—'}</td><td>${m.ab||'—'}</td><td>${m.h||'—'}</td>
        <td>${m.so||'—'}</td><td>${m.bb||'—'}</td><td>${m.hbp||'—'}</td>
        <td>${m.hr||'—'}</td><td>${m.xbh||'—'}</td><td>${m.sb||'—'}</td>
        <td>${fmtAvg(m.avg)}</td><td>${fmtAvg(m.obp)}</td>
        <td>${fmtAvg(m.slg)}</td><td>${fmtAvg(m.ops)}</td>
        <td>${m.kPct != null ? m.kPct.toFixed(1)+'%' : '—'}</td><td>${m.bbPct != null ? m.bbPct.toFixed(1)+'%' : '—'}</td><td>${m.gbPct != null ? m.gbPct.toFixed(1)+'%' : '—'}</td><td>${m.bunts != null ? m.bunts : '—'}</td>
      </tr>`;
    }).join('');

  // ── AI narrative pitchers ──
  const pitcherRows = (pit.pitchers || []).map(p => {
    const bp = bundlePitMap[p.name] || {};
    return `<tr>
      <td><strong>${playerLabel(p.name)}</strong></td>
      <td>${fmtH(bp.total_ip??p.ip,1)}</td>
      <td>${fmtH(bp.era??p.era,2)}</td>
      <td>${fmtH(p.k_bb,2)}</td>
      <td>${threatBadge(p.threat)}</td>
      <td style="font-size:11px">${p.note||''}</td>
    </tr>`;
  }).join('');

  // ── Player summary rows ──
  const playerSummaryRows = players.map(p => {
    const bb = bundleBatMap[p.name] || {};
    const bp = bundlePitMap[p.name] || {};
    const m = calcBattingMetrics(bb, p.stats || {}, getAdv(p.name));
    return `<tr>
      <td><strong>${playerLabel(p.name)}</strong></td>
      <td>${fmtAvg(m.avg)}</td>
      <td>${fmtAvg(m.obp)}</td>
      <td>${m.hr || p.stats?.hr || '—'}</td>
      <td>${bb.total_rbi??p.stats?.rbi??'—'}</td>
      <td>${fmtH(bp.era??p.stats?.era,2)}</td>
      <td style="font-size:11px">${p.scoutingNote||''}</td>
    </tr>`;
  }).join('');

  // ── Per-player pages ──
  const playerDetailPages = players.map(p => {
    const bb   = bundleBatMap[p.name] || {};
    const adv  = getAdv(p.name);
    const sd   = adv.swingDecisions || (adv.swing_decisions
      ? (() => { try { return JSON.parse(adv.swing_decisions); } catch { return null; } })()
      : null);

    const sprayPct = {
      LF: adv.spray_lf_pct??0, CF: adv.spray_cf_pct??0, RF: adv.spray_rf_pct??0,
      '3B': adv.spray_3b_pct??0, SS: adv.spray_ss_pct??0,
      '2B': adv.spray_2b_pct??0, '1B': adv.spray_1b_pct??0, P: adv.spray_pc_pct??0,
    };

    // Fan SVG (GC zones) — or PG png if available
    const pgPng = sprayImages[p.name];
    const gcPng = gcSprayMap[p.name];
    const usePng = pgPng || gcPng;
    const hasZoneData = Object.values(sprayPct).some(v => v > 0);

    let sprayHtml = '';
    if (usePng) {
      sprayHtml = `<img src="data:image/png;base64,${usePng.toString('base64')}" width="220" style="display:block"/>`;
    } else if (hasZoneData) {
      sprayHtml = generateFanSprayChartSVG(sprayPct, playerLabel(p.name));
    } else {
      sprayHtml = `<p style="color:#aaa;font-style:italic;font-size:11px">No spray data</p>`;
    }

    const m = calcBattingMetrics(bb, p.stats || {}, adv);

    const swingRows = sd
      ? ['0-0','0-1','0-2','1-0','1-1','1-2','2-0','2-1','2-2','3-0','3-1','3-2'].map((count,i) => {
          const d = sd[count] || { swing_pct:0, take_k_pct:0, n:0 };
          return `<tr${i%2===1?' style="background:#f5f8fc"':''}>
            <td style="text-align:center;font-weight:bold">${count}</td>
            <td style="text-align:center">${d.swing_pct}%</td>
            <td style="text-align:center">${d.take_k_pct}%</td>
            <td style="text-align:center">${d.n}</td>
          </tr>`;
        }).join('')
      : '<tr><td colspan="4" style="color:#888;font-style:italic;text-align:center">No data</td></tr>';

    return `
  <div class="page-break"></div>
  <h3 class="section">${playerLabel(p.name)}</h3>

  <div style="display:flex;gap:24px;align-items:flex-start">
    <!-- Left: spray chart -->
    <div style="min-width:220px">
      ${sprayHtml}
    </div>

    <!-- Right: stats + swing decisions -->
    <div style="flex:1">
      <h4 class="sub">Stats</h4>
      <table style="width:100%;margin-bottom:6px">
        <thead><tr><th>PA</th><th>AB</th><th>H</th><th>K</th><th>BB</th></tr></thead>
        <tbody><tr>
          <td>${m.pa||'—'}</td><td>${m.ab||'—'}</td><td>${m.h||'—'}</td>
          <td>${m.so||'—'}</td><td>${m.bb||'—'}</td>
        </tr></tbody>
      </table>
      <table style="width:100%;margin-bottom:6px">
        <thead><tr><th>HR</th><th>XBH</th><th>SBA</th><th>HBP</th></tr></thead>
        <tbody><tr>
          <td>${m.hr||p.stats?.hr||'—'}</td>
          <td>${m.xbh||'—'}</td>
          <td>${m.sb||'—'}</td>
          <td>${m.hbp||'—'}</td>
        </tr></tbody>
      </table>
      <table style="width:100%;margin-bottom:6px">
        <thead><tr><th>BA</th><th>OBP</th><th>SLG</th><th>OPS</th></tr></thead>
        <tbody><tr>
          <td>${fmtAvg(m.avg)}</td>
          <td>${fmtAvg(m.obp)}</td>
          <td>${fmtAvg(m.slg)}</td>
          <td>${fmtAvg(m.ops)}</td>
        </tr></tbody>
      </table>
      <table style="width:100%;margin-bottom:12px">
        <thead><tr><th>K%</th><th>BB%</th><th>GB%</th></tr></thead>
        <tbody><tr>
          <td>${m.kPct != null ? m.kPct.toFixed(1)+'%' : '—'}</td>
          <td>${m.bbPct != null ? m.bbPct.toFixed(1)+'%' : '—'}</td>
          <td>${m.gbPct != null ? m.gbPct.toFixed(1)+'%' : '—'}</td>
        </tr></tbody>
      </table>

      <h4 class="sub">Swing Decisions</h4>
      <table style="width:100%">
        <thead><tr><th>Count</th><th>Swing %</th><th>Take K %</th><th>n</th></tr></thead>
        <tbody>${swingRows}</tbody>
      </table>
    </div>
  </div>

  <!-- Scout note full width -->
  ${p.scoutingNote ? `<p style="margin-top:14px;line-height:1.6">${p.scoutingNote}</p>` : ''}
`;
  }).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:Arial, sans-serif; font-size:12px; color:#222; background:white; }
  .page { padding:36px 44px; }
  h1.report-title { font-size:30px; color:#1F3864; text-align:center; letter-spacing:2px; }
  h2.report-sub   { font-size:17px; color:#2E75B6; text-align:center; margin-bottom:6px; }
  .team-name  { font-size:24px; font-weight:bold; color:#1F3864; text-align:center; margin:14px 0 4px; }
  .meta-line  { text-align:center; color:#666; font-size:11px; margin-bottom:4px; }
  hr.title-rule { border:none; border-top:3px solid #1F3864; margin:14px 0; }
  h3.section  { font-size:15px; font-weight:bold; color:#1F3864; border-bottom:2px solid #2E75B6;
                padding-bottom:3px; margin:24px 0 10px; text-transform:uppercase; letter-spacing:1px; }
  h4.sub      { font-size:12px; font-weight:bold; color:#2E75B6; margin:12px 0 5px; }
  p  { margin-bottom:7px; line-height:1.5; }
  ul { margin:4px 0 9px 22px; }
  li { margin-bottom:3px; line-height:1.5; }
  table { width:100%; border-collapse:collapse; margin-bottom:14px; font-size:11px; }
  th { background:#1F3864; color:white; padding:5px 6px; text-align:center; font-size:10px; }
  td { padding:4px 6px; border-bottom:1px solid #e0e0e0; text-align:center; vertical-align:middle; }
  td:first-child { text-align:left; }
  tr:nth-child(even) td { background:#f5f8fc; }
  .stat-grid { display:grid; grid-template-columns:repeat(5,1fr); gap:10px; margin-bottom:14px; }
  .stat-box  { border:1px solid #ccc; border-radius:4px; padding:8px; text-align:center; }
  .stat-val  { font-size:20px; font-weight:bold; color:#1F3864; }
  .stat-lbl  { font-size:9px; color:#666; text-transform:uppercase; margin-top:2px; }
  .note-italic { font-style:italic; color:#555; font-size:11px; }
  .page-break { page-break-before:always; }
  @media print { .page { padding:20px 28px; } body { font-size:11px; } }
</style>
</head>
<body>
<div class="page">

<!-- Cover -->
<h1 class="report-title">VOODOO SCOUT</h1>
<h2 class="report-sub">Intelligence Report</h2>
<hr class="title-rule">
<div class="team-name">Scouting Report</div>
<div class="team-name" style="font-size:20px">${teamName}</div>
<div class="meta-line" style="font-style:italic">Record: ${a._record?.wins??'?'}-${a._record?.losses??'?'}</div>
<div class="meta-line">Generated: ${generated} &nbsp;|&nbsp; ${games} game${games!==1?'s':''} analyzed &nbsp;|&nbsp; Confidence: ${confidence}</div>
<hr class="title-rule">

${conditionsHtml}

<!-- Pitching Summary -->
<div class="page-break"></div>
<h3 class="section">Pitching Summary</h3>
<table>
  <thead><tr><th style="text-align:left">Player</th><th>App</th><th>IP</th><th>ERA</th><th>WHIP</th><th>SO/7</th><th>BB/7</th><th>S%</th></tr></thead>
  <tbody>${pitSummaryRows||'<tr><td colspan="8" style="color:#888">No pitching data</td></tr>'}</tbody>
</table>

<!-- Hitting Summary -->
<div class="page-break"></div>
<h3 class="section">Hitting Summary</h3>
<table>
  <thead><tr>
    <th style="text-align:left">Player</th><th>PA</th><th>AB</th><th>H</th><th>K</th>
    <th>BB</th><th>HBP</th><th>HR</th><th>XBH</th><th>SBA</th>
    <th>BA</th><th>OBP</th><th>SLG</th><th>OPS</th><th>K%</th><th>BB%</th><th>GB%</th><th>Bunts</th>
  </tr></thead>
  <tbody>${hitSummaryRows||'<tr><td colspan="18" style="color:#888">No batting data</td></tr>'}</tbody>
</table>

<!-- Overview -->
<div class="page-break"></div>
<h3 class="section">Overview</h3>
<p>${a.overallSummary||'No summary available.'}</p>
<div class="stat-grid">
  <div class="stat-box"><div class="stat-val">${a._record?.wins??'—'}</div><div class="stat-lbl">Wins</div></div>
  <div class="stat-box"><div class="stat-val">${a._record?.losses??'—'}</div><div class="stat-lbl">Losses</div></div>
  <div class="stat-box"><div class="stat-val">${a._record?.winPct!=null?fmt(a._record.winPct,3):'—'}</div><div class="stat-lbl">Win %</div></div>
  <div class="stat-box"><div class="stat-val">${fmtAvg(a._teamStats?.avg??bat.teamAvg)}</div><div class="stat-lbl">Team AVG</div></div>
  <div class="stat-box"><div class="stat-val">${fmtAvg(a._teamStats?.obp??bat.teamOBP)}</div><div class="stat-lbl">Team OBP</div></div>
</div>

<!-- Batting -->
<div class="page-break"></div>
<h3 class="section">Batting Analysis</h3>
<h4 class="sub">Offensive Approach</h4><p>${bat.approachNotes||'Insufficient data.'}</p>
<h4 class="sub">Strengths</h4>${bullets(bat.keyStrengths)}
<h4 class="sub">Weaknesses / Vulnerabilities</h4>${bullets(bat.keyWeaknesses)}
${bat.vulnerabilities?`<p class="note-italic">${bat.vulnerabilities}</p>`:''}
<h4 class="sub">Hitters to Watch</h4>
${(bat.protectedHitters||[]).map(h=>`
  <div style="display:flex;align-items:center;gap:10px;margin-bottom:7px;padding:7px;border:1px solid #ddd;border-radius:4px">
    <div style="font-weight:bold;min-width:150px">${playerLabel(h.name)}</div>
    ${threatBadge(h.threat)}
    <div style="font-size:12px;color:#333">${h.note}</div>
  </div>`).join('')||'<p style="color:#888;font-style:italic">None identified.</p>'}

<!-- Pitching -->
<div class="page-break"></div>
<h3 class="section">Pitching Analysis</h3>
<p>${pit.staffNotes||'Insufficient data.'}</p>
<table>
  <thead><tr><th style="text-align:left">Pitcher</th><th>IP</th><th>ERA</th><th>K/BB</th><th>Threat</th><th style="text-align:left">Scout Note</th></tr></thead>
  <tbody>${pitcherRows||'<tr><td colspan="6" style="color:#888;text-align:center">No pitching data</td></tr>'}</tbody>
</table>
<h4 class="sub">Fatigue / Overuse Risk</h4><p>${pit.fatigueRisk||'Unknown.'}</p>
<h4 class="sub">Key Strengths</h4>${bullets(pit.keyStrengths)}
<h4 class="sub">Key Weaknesses</h4>${bullets(pit.keyWeaknesses)}

<!-- Tendencies -->
<h3 class="section">Tendencies</h3>
<div class="stat-grid">
  <div class="stat-box"><div class="stat-val" style="font-size:14px">${(tend.offensiveStyle||'?').toUpperCase()}</div><div class="stat-lbl">Style</div></div>
  <div class="stat-box"><div class="stat-val" style="font-size:14px">${(tend.groundBallTendency||'?').toUpperCase()}</div><div class="stat-lbl">Ground Balls</div></div>
  <div class="stat-box"><div class="stat-val" style="font-size:14px">${(tend.strikeoutRate||'?').toUpperCase()}</div><div class="stat-lbl">K Rate</div></div>
  <div class="stat-box"><div class="stat-val" style="font-size:14px">${(tend.walkRate||'?').toUpperCase()}</div><div class="stat-lbl">Walk Rate</div></div>
  <div class="stat-box"><div class="stat-val" style="font-size:14px">${(tend.stolenBaseActivity||'?').toUpperCase()}</div><div class="stat-lbl">SB Activity</div></div>
</div>
<h4 class="sub">Key Patterns</h4>${bullets(tend.keyPatterns)}

<!-- Game Plan -->
<div class="page-break"></div>
<h3 class="section">Game Plan</h3>
<h4 class="sub">Pitching Strategy</h4><p>${gp.pitchingStrategy||'Insufficient data.'}</p>
<h4 class="sub">Defensive Alignment</h4><p>${gp.defensiveAlignment||'Insufficient data.'}</p>
<h4 class="sub">Offensive Approach</h4><p>${gp.offensiveApproach||'Insufficient data.'}</p>
<h4 class="sub">Baserunning</h4><p>${gp.baserunning||'Insufficient data.'}</p>
<h4 class="sub">Key Matchups</h4>${bullets(gp.keyMatchups)}
<h4 class="sub">Things to Avoid</h4>${bullets(gp.thingsToAvoid)}

<!-- Player Breakdown Summary -->
<div class="page-break"></div>
<h3 class="section">Player Breakdowns</h3>
<table>
  <thead><tr><th style="text-align:left">Player</th><th>AVG</th><th>OBP</th><th>HR</th><th>RBI</th><th>ERA</th><th style="text-align:left">Scout Note</th></tr></thead>
  <tbody>${playerSummaryRows||'<tr><td colspan="7" style="color:#888;text-align:center">No player data</td></tr>'}</tbody>
</table>

<!-- Per-player detail pages -->
${playerDetailPages}

<p class="note-italic" style="margin-top:20px">
  Data confidence: ${confidence}. ${a.reportMeta?.confidenceNote||''}
  <br>CONFIDENTIAL — For coaching staff use only.
</p>

</div>
</body>
</html>`;
}

// ─── buildPdf ─────────────────────────────────────────────────────────────────

async function buildPdf(analysis, outputPath) {
  const { chromium } = require('@playwright/test');
  const html = buildReportHtml(analysis);
  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();
  await page.setContent(html, { waitUntil: 'networkidle' });
  await page.pdf({
    path:   outputPath,
    format: 'Letter',
    margin: { top:'0.5in', right:'0.5in', bottom:'0.5in', left:'0.5in' },
    printBackground: true,
  });
  await browser.close();
  console.log(`[report] PDF saved: ${outputPath}`);
  return outputPath;
}

// ─── generateReport ───────────────────────────────────────────────────────────

async function generateReport(analysis, outputDir = './reports') {
  const teamName = analysis.reportMeta?.teamName || analysis._bundle?.team?.team_name || '';
  const pgData   = getPGDataForTeam(analysis._bundle?.team?.team_name || teamName || '');
  analysis._pgData = pgData;

  const sprayData = pgData?.sprayData || {};

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // PG spray chart PNGs (dot-on-field, only if PG data available)
  analysis._sprayImages = {};
  for (const [playerName, playerSpray] of Object.entries(sprayData)) {
    const hits = playerSpray?.hitEvents?.all || [];
    if (!hits.length) continue;
    // Still generate PG dot charts if you have them — they take priority
    // (kept for backwards compat; fan charts are generated inline from GC zone data)
  }

  // GC zone-based fan spray chart PNGs (generated from stats-engine zone pcts)
  analysis._gcSprayImages = {};
  const advPlayerMap = {};
  for (const p of (analysis._playerAdvanced || [])) advPlayerMap[p.player_name] = p;

  for (const player of (analysis.playerBreakdowns || [])) {
    const adv = advPlayerMap[player.name] || Object.values(advPlayerMap).find(p => {
      const norm = s => s.toLowerCase().replace(/[^a-z ]/g,'').trim();
      return norm(p.player_name) === norm(player.name);
    }) || {};

    const sprayPct = {
      LF: adv.spray_lf_pct ?? 0, CF: adv.spray_cf_pct ?? 0, RF: adv.spray_rf_pct ?? 0,
      '3B': adv.spray_3b_pct ?? 0, SS: adv.spray_ss_pct ?? 0,
      '2B': adv.spray_2b_pct ?? 0, '1B': adv.spray_1b_pct ?? 0, P: adv.spray_pc_pct ?? 0,
    };

    if (Object.values(sprayPct).some(v => v > 0)) {
      const svgStr = generateFanSprayChartSVG(sprayPct, player.name);
      const pngBuf = await svgToPngBuffer(svgStr);
      if (pngBuf) analysis._gcSprayImages[player.name] = pngBuf;
    }
  }

  console.log(`[report] Generated ${Object.keys(analysis._gcSprayImages).length} GC fan spray chart(s)`);

  const teamNameSanitized = sanitize(analysis.reportMeta?.teamName || analysis._bundle?.team?.team_name || 'team');
  const date = new Date().toISOString().slice(0, 10);
  const base = `scout-${teamNameSanitized.replace(/\s+/g, '-')}-${date}`;

  const docxPath = path.join(outputDir, `${base}.docx`);
  const pdfPath  = path.join(outputDir, `${base}.pdf`);

  console.log(`\n[report] Generating reports for: ${teamNameSanitized}`);

  try {
    await buildDocx(analysis, docxPath);
  } catch (err) {
    console.error('[report] buildDocx failed:', err.message);
    throw err;
  }
  try {
    await buildPdf(analysis, pdfPath);
  } catch (err) {
    console.error('[report] buildPdf failed:', err.message);
    throw err;
  }

  return { docx: docxPath, pdf: pdfPath };
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = { generateReport, buildDocx, buildPdf, buildReportHtml };