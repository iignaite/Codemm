import type { ReactNode } from 'react';
import { PALETTES, type PaletteName } from './palette';

export type Mood = 'ready' | 'cheer' | 'think' | 'look' | 'soft' | 'sleep' | 'wake';

const INK = '#0E2754';

function eyeAt(cx: number, cy: number) {
  return (
    <g className="eye">
      <circle cx="158" cy="82" r="15" fill="#fff" />
      <circle cx={cx} cy={cy} r="7.5" fill={INK} />
      <circle cx={cx + 2.5} cy={cy - 3} r="2.4" fill="#fff" />
    </g>
  );
}

const smile = <path d="M164 112 Q 177 117 189 104" fill="none" stroke={INK} strokeWidth="3.4" strokeLinecap="round" />;

/** Codemm's mascot. Decorative: it never carries meaning on its own. */
export function Emm({ mood = 'ready', width = 160, palette = 'green', perch = true }: {
  mood?: Mood; width?: number; palette?: PaletteName; perch?: boolean;
}) {
  const p = PALETTES[palette];
  let eye: ReactNode = eyeAt(163, 83);
  let mouth: ReactNode = smile;
  let front: ReactNode = <path d="M140 122 L 146 142" stroke={p.dark} strokeWidth="11" strokeLinecap="round" />;
  let extra: ReactNode = null;

  if (mood === 'cheer') {
    eye = <><circle cx="158" cy="82" r="15" fill="#fff" /><path d="M149 86 Q 158 74 167 86" fill="none" stroke={INK} strokeWidth="4" strokeLinecap="round" /></>;
    mouth = <><path d="M160 106 Q 176 128 192 102 Z" fill={INK} stroke={INK} strokeWidth="3" strokeLinejoin="round" /><path d="M170 112 Q 177 121 184 110 Z" fill="#FF8FA3" /></>;
    front = <path d="M140 118 L 156 92" stroke={p.dark} strokeWidth="11" strokeLinecap="round" />;
    extra = <>
      <path className="spark" d="M186 14 l3 8 8 3 -8 3 -3 8 -3 -8 -8 -3 8 -3z" fill="#F2B705" />
      <path className="spark" style={{ animationDelay: '.5s' }} d="M106 26 l2.5 6 6 2.5 -6 2.5 -2.5 6 -2.5 -6 -6 -2.5 6 -2.5z" fill="#F2B705" />
    </>;
  } else if (mood === 'think') {
    eye = eyeAt(160, 75);
    mouth = <path d="M168 112 L 186 108" fill="none" stroke={INK} strokeWidth="3.4" strokeLinecap="round" />;
  } else if (mood === 'look') {
    eye = eyeAt(153, 86);
  } else if (mood === 'soft') {
    eye = eyeAt(160, 87);
    mouth = <path d="M166 113 Q 176 115 186 110" fill="none" stroke={INK} strokeWidth="3.4" strokeLinecap="round" />;
  } else if (mood === 'sleep') {
    eye = <><circle cx="158" cy="82" r="15" fill={p.dark} /><path d="M146 84 Q 158 92 170 84" fill="none" stroke={INK} strokeWidth="3.4" strokeLinecap="round" /></>;
    mouth = <path d="M170 113 Q 178 115 186 111" fill="none" stroke={INK} strokeWidth="3" strokeLinecap="round" />;
    extra = <>
      <text className="zz" x="176" y="46" fontFamily="Poppins, sans-serif" fontSize="20" fontWeight="600" fill="#AFC0DD">z</text>
      <text className="zz" style={{ animationDelay: '.8s' }} x="190" y="26" fontFamily="Poppins, sans-serif" fontSize="26" fontWeight="600" fill="#AFC0DD">Z</text>
    </>;
  } else if (mood === 'wake') {
    eye = <>{eye}<circle className="lid" cx="158" cy="82" r="15.5" fill={p.dark} /></>;
  }

  return (
    <svg className={`emm ${mood}`} viewBox="0 0 200 170" width={width} height={Math.round((width * 170) / 200)} aria-hidden="true" focusable="false">
      {perch && <rect x="14" y="140" width="176" height="12" rx="6" fill={INK} />}
      <path d="M60 108 C 34 106, 20 128, 28 146 C 36 162, 62 160, 64 144 C 66 132, 50 128, 46 138" fill="none" stroke={p.dark} strokeWidth="13" strokeLinecap="round" />
      <path d="M82 124 L 76 142" stroke={p.dark} strokeWidth="11" strokeLinecap="round" />
      <path d="M120 126 L 126 142" stroke={p.dark} strokeWidth="11" strokeLinecap="round" />
      <ellipse cx="98" cy="106" rx="46" ry="30" fill={p.body} />
      <path d="M58 114 Q 98 144 140 114 Q 98 127 58 114 Z" fill={p.belly} />
      <path d="M82 82 Q 89 98 82 114 M100 78 Q 108 96 100 116 M118 82 Q 125 98 118 114" fill="none" stroke={p.stripe} strokeWidth="5" strokeLinecap="round" />
      <path d="M118 70 C 124 40, 176 32, 192 68 C 202 92, 196 118, 172 124 C 150 130, 124 122, 118 98 Z" fill={p.body} />
      <path d="M121 70 C 126 46, 150 32, 172 40" fill="none" stroke={p.dark} strokeWidth="6" strokeLinecap="round" />
      <circle cx="158" cy="82" r="21" fill={p.dark} />
      {eye}
      {mouth}
      <circle cx="146" cy="110" r="5" fill="#FF8FA3" opacity=".75" />
      {front}
      <path d="M96 132 L 92 142" stroke={p.dark} strokeWidth="11" strokeLinecap="round" />
      {extra}
    </svg>
  );
}
