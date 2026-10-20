import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { HLJSApi } from 'highlight.js';
import type { LearnerFile } from '../../../shared/api';
import { colorize, highlighter } from './colors';

interface Props {
  files: LearnerFile[];
  open: string;
  onOpen: (path: string) => void;
  onChange: (text: string) => void;
  tools: ReactNode;
}

/** A code editor: file tabs, line numbers, and the code colored by its file's extension where highlight.js knows it (§4.10). */
export function Editor({ files, open, onOpen, onChange, tools }: Props) {
  const id = useId();
  const file = files.find((f) => f.path === open) ?? files[0];
  const lines = file.text.split('\n');
  const [hljs, setHljs] = useState<HLJSApi>();
  useEffect(() => {
    let live = true;
    void highlighter().then((h) => live && setHljs(h));
    return () => void (live = false);
  }, []);
  const colored = useMemo(() => (hljs ? colorize(hljs, file.path, file.text) : undefined), [hljs, file.path, file.text]);
  const copy = useRef<HTMLPreElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  // The copy scrolls with the textarea, also when it first appears over one already scrolled.
  const follow = useCallback(() => {
    if (!copy.current || !area.current) return;
    copy.current.scrollLeft = area.current.scrollLeft;
    copy.current.scrollTop = area.current.scrollTop;
  }, []);
  useLayoutEffect(follow, [colored]);
  return (
    <div className="ed">
      <div className="etool">
        <div className="etabs" role="tablist" aria-label="Files">
          {files.map((f) => (
            <button
              key={f.path}
              type="button"
              role="tab"
              id={`${id}-${f.path}`}
              className="etab"
              aria-selected={f.path === file.path}
              aria-controls={`${id}-panel`}
              onClick={() => onOpen(f.path)}
            >
              {f.path}
            </button>
          ))}
        </div>
        <div className="actions">{tools}</div>
      </div>
      <div className="ebody" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${file.path}`}>
        <div className="code">
          <div className="lnum" aria-hidden="true">
            {lines.map((_, i) => <span key={i}>{i + 1}</span>)}
          </div>
          <div className="etext">
            {/* highlight.js escapes the code and adds only class names. The copy is for the eyes; the textarea stays the editor. */}
            {colored !== undefined && <pre className="hl" aria-hidden="true" ref={copy} dangerouslySetInnerHTML={{ __html: colored }} />}
            <textarea
              ref={area}
              className={colored !== undefined ? 'lit' : undefined}
              aria-label={file.path}
              value={file.text}
              rows={lines.length}
              wrap="off"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              onChange={(e) => onChange(e.target.value)}
              onScroll={follow}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
