// Generic colors for Emm and course badges. Picked from the name's characters,
// never from what the name means.
export const PALETTES = {
  green: { body: '#2DC65B', dark: '#17A045', belly: '#A6F0BC', stripe: '#22B34F', badge: '#0E7C35' },
  cyan: { body: '#2CC3E8', dark: '#109CC0', belly: '#BDF0FB', stripe: '#1CB3D8', badge: '#0B7A99' },
  blue: { body: '#6F8BE0', dark: '#4566C8', belly: '#D3DDF8', stripe: '#5A78D4', badge: '#3F5DB8' },
  violet: { body: '#9A7BE0', dark: '#6E4FC2', belly: '#E3DAFA', stripe: '#8A6AD6', badge: '#6E4FC2' },
};

export type PaletteName = keyof typeof PALETTES;

const COURSE_PALETTES: PaletteName[] = ['cyan', 'blue', 'violet', 'green'];

export function paletteFor(name: string): PaletteName {
  let sum = 0;
  for (const ch of name) sum += ch.codePointAt(0) ?? 0;
  return COURSE_PALETTES[sum % COURSE_PALETTES.length];
}
