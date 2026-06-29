'use strict';

const path = require('path');

// src/design/jobu-design-system.js -> project root is two levels up
const ROOT = path.join(__dirname, '..', '..');

module.exports = {
  brand: {
    name: 'JOBU SCOUT',
    subtitle: 'INTELLIGENCE REPORT',
    logoPath: path.join(ROOT, 'assets', 'branding', 'jobu-logo.png'),
    designSystemPath: path.join(ROOT, 'assets', 'branding', 'Jobu Scout Design System.html'),
  },

  colors: {
    navy: '0C121C',
    navy2: '0E1622',
    gold: 'C79A45',
    red: 'C43B32',
    parchment: 'ECE7DA',
    cream: 'F4F0E6',
    white: 'FFFFFF',
    black: '000000',
    grayText: '595959',
    muted: '6F7A89',
    mutedGold: 'D4CEBD',
    altRow: 'F5F2EC',
    borderGold: 'C4B89A',
    threat: {
      high: 'C00000',
      medium: 'E36C09',
      low: '375623',
      default: '000000',
    },
  },

  fonts: {
    docxBody: 'Calibri',
    docxHeading: 'Calibri',
    htmlTitle: "'Bebas Neue', 'Impact', sans-serif",
    htmlHeading: "'Oswald', sans-serif",
    htmlBody: "'Inter', system-ui, sans-serif",
    htmlMono: "'JetBrains Mono', monospace",
  },

  docx: {
    page: {
      width: 12240,
      height: 15840,
      margin: { top: 900, right: 900, bottom: 900, left: 900 },
    },
    logo: {
      headerWidth: 18,
      headerHeight: 21,
      coverWidth: 52,
      coverHeight: 60,
    },
    header: {
      fontSize: 16,
      borderSize: 6,
    },
    footer: {
      fontSize: 16,
      text: 'CONFIDENTIAL — For coaching staff use only',
    },
    table: {
      headerFontSize: 17,
      bodyFontSize: 18,
      compactFontSize: 16,
      borderSize: 1,
      cellMargin: { top: 50, bottom: 50, left: 100, right: 100 },
    },
    headings: {
      sectionSize: 26,
      subheadingSize: 20,
      coverTitleSize: 52,
      coverSubtitleSize: 22,
      coverReportSize: 36,
      coverTeamSize: 30,
      sectionBorderSize: 8,
    },
  },
};
