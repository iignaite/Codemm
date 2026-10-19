// Draws a lesson's diagram. Loaded only when a lesson has one (Diagram.tsx imports this file on demand), because
// mermaid is most of a megabyte.
//
// The agent writes the source, so the drawing is treated as untrusted twice over (docs/desktop/DESIGN.md §2.1, §4.3):
// mermaid runs at its strictest level (labels are encoded, clicks and callbacks are off, and the source can't
// loosen that), and the result is shown only as an <img> of a data: URL. An image runs no script, follows no link and
// loads nothing, so the strict level is a second layer rather than the only one. It also keeps within the CSP, which
// forbids the inline styles an inline SVG would need.
import mermaid from 'mermaid';
import atkinson400 from '../../assets/fonts/atkinson-hyperlegible-next-latin-400-normal.woff2?inline';
import atkinson700 from '../../assets/fonts/atkinson-hyperlegible-next-latin-700-normal.woff2?inline';

/** A drawn diagram: the image, and the text that stands in for it. */
export interface Drawn {
  src: string;
  alt: string;
}

/** The colors a diagram uses, by the name of their token in styles/tokens.css (a test keeps them equal). */
export const palette = {
  ink: '#0E2754',
  muted: '#4A5B7A',
  line: '#DCE3EE',
  ctl: '#8492A9',
  soft: '#F0F3F8',
  card: '#FFFFFF',
  blue: '#3F5DB8',
  'blue-soft': '#E8EDFB',
  'blue-line': '#CDD7F4',
  ok: '#13883D',
  'green-soft': '#E6F7EC',
  'green-line': '#A8E3BB',
  bad: '#B85C00',
  'orange-soft': '#FFF2E0',
  'orange-line': '#F6C88A',
  note: '#FFF7DB',
  'note-ink': '#7A5C00',
} as const;

const FAMILY = 'Atkinson Hyperlegible Next';
const FONT = `"${FAMILY}", sans-serif`;

/** An image can't use the page's fonts, so the two weights a diagram needs travel inside it. */
const FONT_FACES = [[400, atkinson400], [700, atkinson700]]
  .map(([weight, data]) => `@font-face{font-family:"${FAMILY}";font-weight:${weight};src:url(${data}) format("woff2")}`)
  .join('');

const p = palette;
// Pie slices are light, so one label color reads on all of them.
const slices = [p['blue-line'], p['green-line'], p['orange-line'], p.note, p['blue-soft'], p.line];

/** What mermaid will draw; its own limit is 50,000. A 64 KB lesson can't hold a diagram that takes the window with it. */
const MAX_TEXT = 20_000;

let ready = false;
function setup() {
  if (ready) return;
  ready = true;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    suppressErrorRendering: true,
    maxTextSize: MAX_TEXT,
    maxEdges: 150,
    htmlLabels: false,
    // Directives in the source can change any key not listed here (mermaid already locks securityLevel, the sizes and
    // a few more). These are the ones that would undo the settings of this file.
    secure: ['htmlLabels', 'theme', 'themeVariables', 'themeCSS', 'look', 'layout', 'fontFamily'],
    // Mermaid's default layout is ELK, which isn't bundled (stubs/elk.ts); dagre is the classic one, and `classic` the flat look.
    layout: 'dagre',
    look: 'classic',
    theme: 'base',
    fontFamily: FONT,
    // Charts are shorter than mermaid's 700 by 500, which is tall beside a paragraph.
    xyChart: { width: 640, height: 360 },
    themeVariables: {
      background: p.card,
      fontFamily: FONT,
      fontSize: '16px',
      textColor: p.ink,
      lineColor: p.muted,
      primaryColor: p['blue-soft'],
      primaryBorderColor: p.blue,
      primaryTextColor: p.ink,
      secondaryColor: p['green-soft'],
      secondaryBorderColor: p.ok,
      secondaryTextColor: p.ink,
      tertiaryColor: p['orange-soft'],
      tertiaryBorderColor: p.bad,
      tertiaryTextColor: p.ink,
      clusterBkg: p.soft,
      clusterBorder: p.line,
      edgeLabelBackground: p.card,
      noteBkgColor: p.note,
      noteBorderColor: p['orange-line'],
      noteTextColor: p['note-ink'],
      actorBkg: p['blue-soft'],
      actorBorder: p.blue,
      actorTextColor: p.ink,
      actorLineColor: p.ctl,
      signalColor: p.muted,
      signalTextColor: p.ink,
      labelBoxBkgColor: p.soft,
      labelBoxBorderColor: p.ctl,
      activationBkgColor: p['blue-line'],
      activationBorderColor: p.blue,
      ...Object.fromEntries(slices.map((color, i) => [`pie${i + 1}`, color])),
      pieTitleTextSize: '20px',
      pieSectionTextSize: '16px',
      pieLegendTextSize: '16px',
      pieTitleTextColor: p.ink,
      pieSectionTextColor: p.ink,
      pieLegendTextColor: p.ink,
      pieStrokeColor: p.ink,
      pieStrokeWidth: '1px',
      pieOuterStrokeColor: p.line,
      pieOuterStrokeWidth: '1px',
      pieOpacity: '1',
      xyChart: {
        backgroundColor: p.card,
        titleColor: p.ink,
        xAxisTitleColor: p.ink,
        xAxisLabelColor: p.muted,
        xAxisTickColor: p.ctl,
        xAxisLineColor: p.ctl,
        yAxisTitleColor: p.ink,
        yAxisLabelColor: p.muted,
        yAxisTickColor: p.ctl,
        yAxisLineColor: p.ctl,
        plotColorPalette: [p.blue, p.ok, p.bad, p.ink].join(','),
      },
    },
  });
}

let drawings = 0;

/** Draws the source, or rejects when mermaid can't. */
export async function drawDiagram(source: string): Promise<Drawn> {
  // Over the limit, mermaid draws a box saying so instead of failing, and the learner would lose the source.
  if (source.length > MAX_TEXT) throw new Error('The diagram is too large to draw');
  setup();
  // Text is measured in the page (in a box that app.css sets to this font), so the fonts must be in before it is.
  await Promise.all([400, 700].map((weight) => document.fonts?.load(`${weight} 16px "${FAMILY}"`)));
  const { svg } = await mermaid.render(`diagram-${++drawings}`, source);
  return image(svg, source);
}

/** The drawing as an image of its own natural size, in the app's font, with the title and description the source gave it. */
function image(svg: string, source: string): Drawn {
  // Parsed as HTML, which forgives what mermaid leaves in a drawing; serialized again, it is well-formed XML.
  const root = new DOMParser().parseFromString(svg, 'text/html').querySelector('svg');
  const box = root?.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (!root || box?.length !== 4 || !box.every(Number.isFinite)) throw new Error('mermaid drew no diagram');
  root.setAttribute('width', String(Math.ceil(box[2])));
  root.setAttribute('height', String(Math.ceil(box[3])));
  root.removeAttribute('style');
  // Nothing in the image points outside it: a link keeps its label but loses its address, and pictures, frames and scripts go.
  for (const el of root.querySelectorAll('a, image, img, iframe, script')) {
    if (el.localName === 'a') el.replaceWith(...el.childNodes);
    else el.remove();
  }
  const text = (tag: string) => [...root.children].find((c) => c.localName === tag)?.textContent?.trim() ?? '';
  const style = root.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = FONT_FACES;
  root.prepend(style);
  const alt = [text('title').replace(/[.\s]+$/, ''), text('desc')].filter(Boolean).join('. ');
  return {
    src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(root))}`,
    // With no description from the agent, the source is the one text the diagram has.
    alt: alt || `Diagram. ${source.replace(/\s+/g, ' ').slice(0, 400)}`,
  };
}
