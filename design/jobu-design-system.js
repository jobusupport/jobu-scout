'use strict';

const path = require('path');

const ROOT_DIR = path.join(__dirname, '..', '..');

const DESIGN = {
  brand: {
    name: 'JOBU SCOUT',
    subtitle: 'INTELLIGENCE REPORT',
    confidentiality: 'CONFIDENTIAL — For coaching staff use only',

    // This resolves to:
    // assets/branding/jobu-logo.png
    logoPath: path.join(ROOT_DIR, 'assets', 'branding', 'jobu-logo.png'),

    // Optional reference copy of the original Claude/HTML design system.
    designSystemHtmlPath: path.join(ROOT_DIR, 'assets', 'branding', 'Jobu Scout Design System.html'),
  },

  colors: {
    navy: '0C121C',
    gold: 'C79A45',
    white: 'FFFFFF',
    black: '000000',

    parchment: 'ECE7DA',
    mutedGold: 'D4CEBD',
    altRow: 'F5F2EC',
    border: 'C4B89A',
    grayText: '595959',

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

    htmlBody: "'Inter', system-ui, sans-serif",
    htmlHeading: "'Oswald', sans-serif",
    htmlTitle: "'Bebas Neue', 'Impact', sans-serif",
  },

  docx: {
    page: {
      size: {
        width: 12240,
        height: 15840,
      },
      margin: {
        top: 900,
        right: 900,
        bottom: 900,
        left: 900,
      },
    },

    header: {
      logoWidth: 22,
      logoHeight: 22,
      fontSize: 16,
      borderSize: 6,
    },

    cover: {
      logoWidth: 92,
      logoHeight: 92,
      titleSize: 52,
      subtitleSize: 22,
      reportTitleSize: 36,
      teamNameSize: 30,
      recordSize: 22,
    },

    footer: {
      fontSize: 16,
    },

    table: {
      headerFontSize: 17,
      bodyFontSize: 18,
      compactFontSize: 16,
      cellMargin: {
        top: 50,
        bottom: 50,
        left: 100,
        right: 100,
      },
    },

    headings: {
      sectionSize: 26,
      subheadingSize: 20,
      sectionBorderSize: 8,
    },
  },

  html: {
    pageMargin: {
      top: '0.5in',
      right: '0.5in',
      bottom: '0.5in',
      left: '0.5in',
    },
  },
};

module.exports = DESIGN;