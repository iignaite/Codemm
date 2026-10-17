import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { SourceFile } from '../../../shared/api';

export interface Mark {
  line: number;
  good: boolean;
}

/** Plain-text code editor with file tabs and line numbers. No syntax highlighting: Codemm ships no languages. */
export function Editor({ files, tab, onTab, onChange, mark, actions }: {
  files: SourceFile[]; tab: number; onTab: (i: number) => void; onChange: (content: string) => void; mark?: Mark; actions: ReactNode;
}) {
  const id = useId();
  const gutter = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const file = files[tab];
  const lines = file.content.split('\n').length;

  function onTabKey(e: KeyboardEvent) {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    const next = (tab + step + files.length) % files.length;
    onTab(next);
    document.getElementById(`${id}-tab-${next}`)?.focus();
  }

  return (
    <div className="ed">
      <div className="etool">
        <div className="etabs" role="tablist" aria-label="Files" onKeyDown={onTabKey}>
          {files.map((f, i) => (
            <button key={f.path} id={`${id}-tab-${i}`} type="button" role="tab" className="etab" aria-selected={i === tab}
              aria-controls={`${id}-panel`} tabIndex={i === tab ? 0 : -1} onClick={() => onTab(i)}>
              {f.path}
            </button>
          ))}
        </div>
        <div className="row-actions">{actions}</div>
      </div>
      <div className="ebody" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`}>
        <div className="lnum" ref={gutter} aria-hidden="true">
          {Array.from({ length: lines }, (_, i) => i + 1).join('\n')}
        </div>
        <div className="code">
          {mark && mark.line <= lines && (
            <div key={`${mark.line}${mark.good}`} className={`mark ${mark.good ? 'good' : ''}`}
              style={{ top: `calc(16px + ${(mark.line - 1) * 1.8}em - ${scroll}px)` }} />
          )}
          <textarea aria-label={file.path} spellCheck={false} autoCapitalize="off" autoCorrect="off" value={file.content}
            onChange={(e) => onChange(e.target.value)}
            onScroll={(e) => {
              setScroll(e.currentTarget.scrollTop);
              if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
            }} />
        </div>
      </div>
    </div>
  );
}
