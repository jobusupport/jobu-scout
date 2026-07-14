// ---------------------------------------------------------------------------
// extractDiamondKastPitchByPitch — reads the DiamondKast "Pitch By Pitch" tab
// DOM directly and returns a structured, chronological list of at-bats, each
// with its individual pitches (speed, type, and ball/strike/foul/out call).
//
// Replaces extractPitchByPitchData() above, which only free-text-matched
// outcome lines and never captured pitch velocity or pitch type at all.
//
// DOM shape (verified against a real saved DiamondKast play-by-play page):
//   Every at-bat is TWICE-WRAPPED — DiamondKast renders both a visiting-team
//   panel (#..._pnlPlayBatterTop_{N}, green) and a home-team panel
//   (#..._pnlPlayBatter_{N}, white) at the SAME index N, but only ONE is
//   actually populated depending on which team is up. Relying on either
//   wrapper alone silently drops every at-bat from the OTHER team — instead
//   we anchor on #..._hlBatterNameAbove_{N}, which only exists (once, real
//   text) on whichever of the two panels is actually the live one.
//   The batting team is NOT reliably given by hfBatterTeamName_{N} (it's
//   only rendered on ~1 in 60 at-bats in practice) — instead we derive it
//   from the inning badge itself (#..._h1AnchorAbove_{N}, e.g. "Top 6" /
//   "Bot 5"), which IS populated on every single at-bat, combined with the
//   away/home team names passed in by the caller (away bats in the Top half,
//   home bats in the Bottom half — standard baseball convention).
//   Each header is followed by 1+ "pitch row" elements sharing the SAME
//   index range: #..._pnlPlaySequence_{N}, {N+1}, {N+2}, ... IMPORTANT:
//   pitch rows are rendered NEWEST-FIRST (index N = the LAST pitch of the
//   at-bat — the ball-in-play/strikeout pitch; the highest index in the
//   group = the FIRST pitch of the at-bat). We reverse each group to get
//   true chronological pitch order (pitch 1, 2, 3... as actually thrown).
//
// @param {import('playwright').Page} page
// @param {{awayTeam?: string, homeTeam?: string}} [teams] - names as they
//   should appear in the returned battingTeam field. If omitted, battingTeam
//   falls back to whatever DiamondKast's own (sparse) hfBatterTeamName value
//   was carried forward, which will be null for most at-bats — always pass
//   these when you know them (box score metadata already captures both).
// ---------------------------------------------------------------------------
async function extractDiamondKastPitchByPitch(page, teams = {}) {
  const { awayTeam = null, homeTeam = null } = teams;
  return await page.evaluate(({ awayTeam, homeTeam }) => {
    const PREFIX = "ContentTopLevel_ContentPlaceHolder1_rptInnnings_";

    const byId = (base, idx) => document.getElementById(`${PREFIX}${base}_${idx}`);
    const txt = (base, idx) => {
      const el = byId(base, idx);
      return el ? el.textContent.trim() : null;
    };
    const val = (base, idx) => {
      const el = byId(base, idx);
      if (!el) return null;
      return el.hasAttribute("value") ? el.getAttribute("value") : el.textContent.trim();
    };

    const headerPat = new RegExp(`^${PREFIX}hlBatterNameAbove_(\\d+)$`);
    const seqPat = new RegExp(`^${PREFIX}pnlPlaySequence_(\\d+)$`);

    const headerIndices = Array.from(
      document.querySelectorAll(`[id^="${PREFIX}hlBatterNameAbove_"]`)
    )
      .map((el) => parseInt(headerPat.exec(el.id)[1], 10))
      .sort((a, b) => a - b);

    const seqIndices = Array.from(
      document.querySelectorAll(`[id^="${PREFIX}pnlPlaySequence_"]`)
    )
      .map((el) => parseInt(seqPat.exec(el.id)[1], 10))
      .sort((a, b) => a - b);

    const atBats = [];
    let fallbackTeam = null; // used only if awayTeam/homeTeam weren't provided

    for (let h = 0; h < headerIndices.length; h++) {
      const start = headerIndices[h];
      const end = h + 1 < headerIndices.length ? headerIndices[h + 1] : Infinity;
      const group = seqIndices.filter((i) => i >= start && i < end).sort((a, b) => a - b);
      const chronological = [...group].reverse(); // oldest pitch first

      const inningBadge = txt("h1AnchorAbove", start); // e.g. "Top 6" / "Bot 5"
      const half = inningBadge && /^bot/i.test(inningBadge) ? "Bot" : "Top";

      let battingTeam;
      if (awayTeam && homeTeam) {
        battingTeam = half === "Top" ? awayTeam : homeTeam;
      } else {
        const teamRaw = val("hfBatterTeamName", start);
        if (teamRaw) fallbackTeam = teamRaw;
        battingTeam = fallbackTeam;
      }

      const batterNameRaw = txt("hlBatterNameAbove", start);
      // Batter/pitcher labels are sometimes jersey-number-prefixed
      // ("28 Aiden Bradley"), sometimes not ("Landyn Sturkie") — strip
      // consistently either way.
      const batterName = batterNameRaw ? batterNameRaw.replace(/^\d+\s+/, "").trim() : null;
      const pitcherRaw = txt("hlPitcherNameAbove", start);
      const pitcherName = pitcherRaw ? pitcherRaw.replace(/^\d+\s+/, "").trim() : null;

      const pitches = chronological.map((idx, i) => {
        const speedText = txt("lblPitchSpeed", idx);
        const speedMatch = speedText && speedText.match(/(\d+)/);
        return {
          pitchNumInAB: i + 1,
          play: txt("lblPlay", idx),
          hitType: txt("lblHitType", idx) || null,
          fielding: txt("lblPlaySequence", idx) || null,
          outsAfter: txt("lblOuts", idx) || null,
          speedMph: speedMatch ? Number(speedMatch[1]) : null,
          pitchType: txt("lblPitchType", idx) || null,
        };
      });

      if (!batterName && !pitches.length) continue;

      atBats.push({
        battingTeam,
        inningHalf: half,
        inning: inningBadge,
        batter: batterName,
        pitcher: pitcherName,
        pitchCount: pitches.length,
        pitches,
      });
    }

    return atBats;
  }, { awayTeam, homeTeam }).catch(() => []);
}

module.exports = { extractDiamondKastPitchByPitch };
