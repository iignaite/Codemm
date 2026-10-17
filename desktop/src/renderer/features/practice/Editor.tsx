import { useId, type ReactNode } from 'react';
import type { LearnerFile } from '../../../shared/api';

interface Props {
  files: LearnerFile[];
  open: string;
  onOpen: (path: string) => void;
  onChange: (text: string) => void;
  tools: ReactNode;
}

/** A plain code editor: file tabs and line numbers. */
export function Editor({ files, open, onOpen, onChange, tools }: Props) {
  const id = useId();
  const file = files.find((f) => f.path === open) ?? files[0];
  const lines = file.text.split('\n');
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
          <textarea
            aria-label={file.path}
            value={file.text}
            rows={lines.length}
            wrap="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      </div>
    </div>
  );
}
