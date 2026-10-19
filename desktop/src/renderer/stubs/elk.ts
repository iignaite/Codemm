// Stands in for elkjs (vite.config.mts). Mermaid can lay a diagram out with ELK, but only when a diagram asks for it;
// Codemm draws with the default layout, and elkjs is the one bundled library licensed under the EPL rather than MIT,
// ISC, BSD or Apache (DESIGN §4.3). A diagram that asks for ELK doesn't draw, and its source is shown.
export default class Elk {
  constructor() {
    throw new Error('The ELK layout is not included.');
  }
}
