// Stands in for elkjs (vite.config.mts). Mermaid's default layout is ELK, but Codemm sets dagre (drawDiagram.ts), and
// elkjs is the one bundled library licensed under the EPL rather than MIT, ISC, BSD or Apache (DESIGN §4.3). Anything
// that still reaches ELK fails here, and the lesson shows that diagram's source.
export default class Elk {
  constructor() {
    throw new Error('The ELK layout is not included.');
  }
}
