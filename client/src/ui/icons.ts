// Pixel art interface icons (pixel maps -> crisp edge SVG), consistent with the office style.
// Each '#' represents a pixel filled with currentColor; rendered at 2 screen px per pixel.

function pixelPaths(rows: readonly string[], palette: Readonly<Record<string, string>>): string {
  let out = '';
  for (const [ch, color] of Object.entries(palette)) {
    let d = '';
    rows.forEach((row, y) => {
      // Group consecutive pixels on row into a single rectangle.
      let x = 0;
      while (x < row.length) {
        if (row[x] !== ch) {
          x++;
          continue;
        }
        let run = 1;
        while (row[x + run] === ch) run++;
        d += `M${x} ${y}h${run}v1h-${run}z`;
        x += run;
      }
    });
    if (d) out += `<path fill="${color}" d="${d}"/>`;
  }
  return out;
}

export function pixelIcon(rows: readonly string[], palette: Readonly<Record<string, string>> = { '#': 'currentColor' }, cls = 'ui-px-icon'): string {
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  return `<svg class="${cls}" width="${w * 2}" height="${h * 2}" viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${pixelPaths(rows, palette)}</svg>`;
}

export const ICONS = {
  overview: pixelIcon([
    '###....###',
    '#........#',
    '#........#',
    '...####...',
    '...#..#...',
    '...#..#...',
    '...####...',
    '#........#',
    '#........#',
    '###....###',
  ]),
  zoomIn: pixelIcon([
    '..........',
    '....##....',
    '....##....',
    '....##....',
    '.########.',
    '.########.',
    '....##....',
    '....##....',
    '....##....',
    '..........',
  ]),
  zoomOut: pixelIcon([
    '..........',
    '..........',
    '..........',
    '..........',
    '.########.',
    '.########.',
    '..........',
    '..........',
    '..........',
    '..........',
  ]),
  sidebar: pixelIcon([
    '##########',
    '#..#.....#',
    '#..#.....#',
    '#..#.....#',
    '#..#.....#',
    '#..#.....#',
    '#..#.....#',
    '#..#.....#',
    '#..#.....#',
    '##########',
  ]),
  feed: pixelIcon([
    '##########',
    '#........#',
    '#........#',
    '#........#',
    '##########',
    '#.##.###.#',
    '#........#',
    '#.##.##..#',
    '#........#',
    '##########',
  ]),
  settings: pixelIcon([
    '....##....',
    '.#.####.#.',
    '..######..',
    '.###..###.',
    '####..####',
    '####..####',
    '.###..###.',
    '..######..',
    '.#.####.#.',
    '....##....',
  ]),
  help: pixelIcon([
    '..######..',
    '.##....##.',
    '.##....##.',
    '......##..',
    '.....##...',
    '....##....',
    '....##....',
    '..........',
    '....##....',
    '....##....',
  ]),
  maximize: pixelIcon([
    '..........',
    '.####.....',
    '.##.......',
    '.#.#......',
    '.#........',
    '........#.',
    '......#.#.',
    '.......##.',
    '.....####.',
    '..........',
  ]),
  restore: pixelIcon([
    '..........',
    '...#......',
    '...#......',
    '.###......',
    '..........',
    '..........',
    '......###.',
    '......#...',
    '......#...',
    '..........',
  ]),
  pencil: pixelIcon([
    '.......##.',
    '......#..#',
    '.....#..#.',
    '....#..#..',
    '...#..#...',
    '..#..#....',
    '.#..#.....',
    '.#.#......',
    '.##.......',
    '..........',
  ]),
  close: pixelIcon([
    '..........',
    '.##....##.',
    '.###..###.',
    '..######..',
    '...####...',
    '...####...',
    '..######..',
    '.###..###.',
    '.##....##.',
    '..........',
  ]),
  search: pixelIcon([
    '.####.....',
    '#....#....',
    '#....#....',
    '#....#....',
    '#....#....',
    '.####.....',
    '.....##...',
    '......##..',
    '.......##.',
    '........#.',
  ]),
  copy: pixelIcon([
    '...#######',
    '...#.....#',
    '...#.....#',
    '#######..#',
    '#.....#..#',
    '#.....#..#',
    '#.....####',
    '#.....#...',
    '#.....#...',
    '#######...',
  ]),
  check: pixelIcon([
    '..........',
    '.........#',
    '........##',
    '.......##.',
    '#.....##..',
    '##...##...',
    '.##.##....',
    '..###.....',
    '...#......',
    '..........',
  ]),
  follow: pixelIcon([
    '....##....',
    '....##....',
    '..######..',
    '.#......#.',
    '##..##..##',
    '##..##..##',
    '.#......#.',
    '..######..',
    '....##....',
    '....##....',
  ]),
  center: pixelIcon([
    '###....###',
    '#........#',
    '#........#',
    '....##....',
    '...####...',
    '...####...',
    '....##....',
    '#........#',
    '#........#',
    '###....###',
  ]),
  hand: pixelIcon([
    '...#.#....',
    '..#.#.#...',
    '..#.#.#.#.',
    '..#.#.#.#.',
    '..#######.',
    '#.#######.',
    '##.######.',
    '.########.',
    '..######..',
    '...####...',
  ]),
  warn: pixelIcon([
    '....##....',
    '...####...',
    '...#..#...',
    '..##..##..',
    '..##..##..',
    '.###..###.',
    '.########.',
    '####..####',
    '##########',
    '..........',
  ]),
  clock: pixelIcon([
    '..######..',
    '.#......#.',
    '#....#...#',
    '#....#...#',
    '#....###.#',
    '#........#',
    '#........#',
    '.#......#.',
    '..######..',
    '..........',
  ]),
  // Hourglass (waiting for shell): outline in text color and amber falling sand.
  hourglass: pixelIcon(
    [
      '#########',
      '.#sssss#.',
      '.#sssss#.',
      '..#sss#..',
      '...#s#...',
      '...#s#...',
      '..#.s.#..',
      '.#..s..#.',
      '.#.sss.#.',
      '#########',
    ],
    { '#': 'currentColor', s: '#f7c76b' },
  ),
  // Terminal window with ">_" prompt.
  terminal: pixelIcon([
    '##########',
    '#........#',
    '#.#......#',
    '#..#.....#',
    '#...#....#',
    '#..#.....#',
    '#.#..###.#',
    '#........#',
    '##########',
  ]),
  /** Person with a +: new agent (+ alone represents camera zoom-in). */
  newAgent: pixelIcon(['..##......', '.####.....', '.####...#.', '..##...###', '........#.', '.####.....', '######....', '######....']),
  delivery: pixelIcon(['...####...', '..#....#..', '.#......#.', '##########', '#....#...#', '#...###..#', '#....#...#', '#........#', '##########']),
  chevronLeft: pixelIcon(['....##', '...##.', '..##..', '.##...', '..##..', '...##.', '....##']),
  chevronRight: pixelIcon(['##....', '.##...', '..##..', '...##.', '..##..', '.##...', '##....']),
  mic: pixelIcon(['...##...', '..####..', '..####..', '..####..', '#.####.#', '#..##..#', '.#....#.', '..####..', '...##...', '..####..']),
  stopRec: pixelIcon(['........', '.######.', '.######.', '.######.', '.######.', '.######.', '.######.', '........']),
  attach: pixelIcon(['...###..', '..#...#.', '..#.#.#.', '..#.#.#.', '..#.#.#.', '..#.#.#.', '..#...#.', '...###..']),
  lock: pixelIcon(['..####..', '.##..##.', '.#....#.', '.#....#.', '########', '###..###', '###..###', '########', '########']),
  chevronDown: pixelIcon(['#......#', '##....##', '.##..##.', '..####..', '...##...']),
  chevronUp: pixelIcon(['...##...', '..####..', '.##..##.', '##....##', '#......#']),
  arrowDown: pixelIcon(['...##...', '...##...', '...##...', '#######.', '.#####..', '..###...', '...#....'].map((r) => r.padEnd(8, '.'))),
  /** Habblaud World city (World button): buildings of varying heights. */
  city: pixelIcon(['......##..', '..##..##..', '..##.####.', '####.#..#.', '#..#.####.', '####.#..#.', '#..#.####.', '####.#..#.', '##########']),
  /** The office (button returning from city): a building with a door. */
  office: pixelIcon(['..######..', '..#.##.#..', '..######..', '..#.##.#..', '..######..', '..#.##.#..', '..##..##..', '..##..##..', '##########']),
} as const;

export type IconKey = keyof typeof ICONS;

/** Habblaud pixel brandmark (used when /assets/brand/logo-mark.png is absent): building with lit windows. */
export const FALLBACK_MARK = pixelIcon(
  [
    '.....######.....',
    '.....#rrrr#.....',
    '..############..',
    '..#llllllllll#..',
    '..#lwwlwwlbbl#..',
    '..#lwwlwwlbbl#..',
    '..#llllllllll#..',
    '..#lbblwwlwwl#..',
    '..#lbblwwlwwl#..',
    '..#llllllllll#..',
    '..#lwwlddlbbl#..',
    '..#lwwlddlbbl#..',
    '..#llllddllll#..',
    '################',
  ],
  { '#': '#2b3550', l: '#dfe6f2', r: '#ff8a5b', w: '#ffd36b', b: '#7cc8ff', d: '#3a4566' },
  'ui-px-icon ui-mark',
);

/**
 * "Habblaud" pixel wordmark, using same bitmap font as brand signage (assets/brand/signage.png, generated by
 * scripts/assets/pixelart.py): Pixelify Sans isn't crisp at this size.
 * c = "Hab" (cream), t = "blaud" (amber), s = 1px shadow.
 */
export const WORDMARK_ROWS = [
  'c...c.......c.....t.....tt..................t',
  'c...c.......c.....t.....st..................t',
  'c...c..ccc..cccc..tttt...t...ttt..t...t..tttt',
  'ccccc..sssc.csssc.tssst..t...ssst.t...t.tssst',
  'csssc..cccc.c...c.t...t..t...tttt.t...t.t...t',
  'c...c.csssc.c...c.t...t..t..tssst.t...t.t...t',
  'c...c.scccc.ccccs.tttts.ttt.stttt.stttt.stttt',
  's...s..ssss.ssss..ssss..sss..ssss..ssss..ssss',
] as const;

export const WORDMARK = pixelIcon(WORDMARK_ROWS, { s: 'rgba(6, 8, 14, 0.62)', c: '#f4f1ea', t: '#fac665' }, 'ui-wordmark');

/** Official Antigravity logo for account chips. */
export const ANTIGRAVITY_CHIP_SVG =
  '<svg class="ui-acc-chip__svg" viewBox="0 0 180 180" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M144.248 149.062C151.748 154.688 162.998 150.938 152.685 140.625C121.748 110.625 128.31 28.125 89.8727 28.125C51.4352 28.125 57.9977 110.625 27.0602 140.625C15.8102 151.875 27.9977 154.688 35.4977 149.062C64.5602 129.375 62.6852 94.6875 89.8727 94.6875C117.06 94.6875 115.185 129.375 144.248 149.062Z" fill="#FFFFFF"/></svg>';

/** Official Kilo logo for account chips. */
export const KILO_CHIP_SVG =
  '<svg class="ui-acc-chip__svg" viewBox="0 0 512 512" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false"><path d="M322 377H377V421H307.857L278 391.143V322H322V377ZM421 307.857L391.143 278H322V322L377 322V377H421V307.857ZM234 278H190V322H234V278ZM91 391.143L120.857 421H234V377H135V278H91V391.143ZM371.172 189.999V120.856L341.315 90.9995H278V135H327.172V189.999H278V233.999H421V189.999H371.172ZM135 91H91V233.999H135V184.5H190V233.999H234V184.5L190 140.5H135V91ZM234 91H190V140.5H234V91Z" fill="#FAF74F"/></svg>';
