import type { ReactNode } from 'react';

export type Mood = 'ready' | 'cheer' | 'think' | 'look' | 'soft' | 'sleep' | 'wake';

// Body, dark, belly, stripe.
const PALETTES = [
  ['#2DC65B', '#17A045', '#A6F0BC', '#22B34F'],
  ['#2CC3E8', '#109CC0', '#BDF0FB', '#1CB3D8'],
  ['#6F8BE0', '#4566C8', '#D3DDF8', '#5A78D4'],
  ['#9A7BE0', '#6E4FC2', '#E3DAFA', '#8A6AD6'],
];

/** A stable color for a track or course name. Emm is green with no name. */
export function hue(name?: string): number {
  if (!name) return 0;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 1 + (h % (PALETTES.length - 1));
}

export function hueColor(name?: string): string {
  return PALETTES[hue(name)][1];
}

const INK = '#0E2754';
const eyeAt = (x: number, y: number) => (
  <g className="eye">
    <circle cx="158" cy="82" r="15" fill="#fff" />
    <circle cx={x} cy={y} r="7.5" fill={INK} />
    <circle cx={x + 2.5} cy={y - 3} r="2.4" fill="#fff" />
  </g>
);
const line = (d: string, w = 3.4) => <path d={d} fill="none" stroke={INK} strokeWidth={w} strokeLinecap="round" />;

function face(mood: Mood, dark: string): { eye: ReactNode; mouth: ReactNode; front: string; extra?: ReactNode } {
  const front = 'M140 122 L 146 142';
  const smile = line('M164 112 Q 177 117 189 104');
  switch (mood) {
    case 'cheer':
      return {
        eye: <><circle cx="158" cy="82" r="15" fill="#fff" /><path d="M149 86 Q 158 74 167 86" fill="none" stroke={INK} strokeWidth="4" strokeLinecap="round" /></>,
        mouth: <><path d="M160 106 Q 176 128 192 102 Z" fill={INK} stroke={INK} strokeWidth="3" strokeLinejoin="round" /><path d="M170 112 Q 177 121 184 110 Z" fill="#FF8FA3" /></>,
        front: 'M140 118 L 156 92',
        extra: <>
          <path className="spark" d="M186 14 l3 8 8 3 -8 3 -3 8 -3 -8 -8 -3 8 -3z" fill="#F2B705" />
          <path className="spark" style={{ animationDelay: '.5s' }} d="M106 26 l2.5 6 6 2.5 -6 2.5 -2.5 6 -2.5 -6 -6 -2.5 6 -2.5z" fill="#F2B705" />
        </>,
      };
    case 'think':
      return { eye: eyeAt(160, 75), mouth: line('M168 112 L 186 108'), front };
    case 'look':
      return { eye: eyeAt(153, 86), mouth: smile, front };
    case 'soft':
      return { eye: eyeAt(160, 87), mouth: line('M166 113 Q 176 115 186 110'), front };
    case 'sleep':
      return {
        eye: <><circle cx="158" cy="82" r="15" fill={dark} />{line('M146 84 Q 158 92 170 84')}</>,
        mouth: line('M170 113 Q 178 115 186 111', 3),
        front,
        extra: <>
          <text className="zz" style={{ fontFamily: 'var(--display)' }} x="176" y="46" fontSize="20" fontWeight="600" fill="#AFC0DD">z</text>
          <text className="zz" style={{ fontFamily: 'var(--display)', animationDelay: '.8s' }} x="190" y="26" fontSize="26" fontWeight="600" fill="#AFC0DD">Z</text>
        </>,
      };
    case 'wake':
      return { eye: <>{eyeAt(163, 83)}<circle className="lid" cx="158" cy="82" r="15.5" fill={dark} /></>, mouth: smile, front };
    default:
      return { eye: eyeAt(163, 83), mouth: smile, front };
  }
}

/** Emm, Codemm's mascot. Decorative: whatever Emm means is said in text nearby. */
export function Emm({ mood = 'ready', width = 160, perch = false, name }: { mood?: Mood; width?: number; perch?: boolean; name?: string }) {
  const [body, dark, belly, stripe] = PALETTES[hue(name)];
  const { eye, mouth, front, extra } = face(mood, dark);
  const leg = (d: string) => <path d={d} stroke={dark} strokeWidth="11" strokeLinecap="round" />;
  return (
    <svg className={`emm ${mood}`} viewBox="0 0 200 170" width={width} height={Math.round((width * 170) / 200)} aria-hidden="true">
      {perch && <rect x="14" y="140" width="176" height="12" rx="6" fill={INK} />}
      <path d="M60 108 C 34 106, 20 128, 28 146 C 36 162, 62 160, 64 144 C 66 132, 50 128, 46 138" fill="none" stroke={dark} strokeWidth="13" strokeLinecap="round" />
      {leg('M82 124 L 76 142')}
      {leg('M120 126 L 126 142')}
      <ellipse cx="98" cy="106" rx="46" ry="30" fill={body} />
      <path d="M58 114 Q 98 144 140 114 Q 98 127 58 114 Z" fill={belly} />
      <path d="M82 82 Q 89 98 82 114 M100 78 Q 108 96 100 116 M118 82 Q 125 98 118 114" fill="none" stroke={stripe} strokeWidth="5" strokeLinecap="round" />
      <path d="M118 70 C 124 40, 176 32, 192 68 C 202 92, 196 118, 172 124 C 150 130, 124 122, 118 98 Z" fill={body} />
      <path d="M121 70 C 126 46, 150 32, 172 40" fill="none" stroke={dark} strokeWidth="6" strokeLinecap="round" />
      <circle cx="158" cy="82" r="21" fill={dark} />
      {eye}
      {mouth}
      <circle cx="146" cy="110" r="5" fill="#FF8FA3" opacity=".75" />
      {leg(front)}
      {leg('M96 132 L 92 142')}
      {extra}
    </svg>
  );
}
