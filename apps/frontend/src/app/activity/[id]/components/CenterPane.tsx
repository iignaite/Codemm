"use client";

import { useRef, useEffect, useState } from "react";
import Editor from "@monaco-editor/react";
import type { FileRole, LanguageId } from "@/lib/languages";
import type { CodeFiles, RunResult, FeedbackState } from "../types";
import { stripAnsi, normalizeDiagnostics } from "../utils";

type Props = {
  files: CodeFiles;
  fileRoles: Record<string, FileRole>;
  activeFilename: string;
  selectedLanguage: LanguageId;
  isActiveReadonly: boolean;
  canRunMain: boolean;
  entryFile: string;
  running: boolean;
  submitting: boolean;
  feedback: FeedbackState | null;
  onFileSelect: (filename: string) => void;
  onCodeChange: (filename: string, value: string) => void;
  onRun: () => void;
  onCheckCode: () => void;
  onAddFile: () => void;
  onDeleteFile: (filename: string) => void;
  isFileDeletable: (filename: string) => boolean;
};

export default function CenterPane({
  files,
  fileRoles,
  activeFilename,
  selectedLanguage,
  isActiveReadonly,
  canRunMain,
  entryFile,
  running,
  submitting,
  feedback,
  onFileSelect,
  onCodeChange,
  onRun,
  onCheckCode,
  onAddFile,
  onDeleteFile,
  isFileDeletable,
}: Props) {
  const editorRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const todoDecorationsRef = useRef<string[]>([]);
  const [terminalOpen, setTerminalOpen] = useState(true);
  const [terminalHeight, setTerminalHeight] = useState(180);

  const activeCode = files[activeFilename] ?? "";

  function updateTodoDecorations(nextCode: string) {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;

    const lines = String(nextCode ?? "").split("\n");
    const ranges: Array<{ start: number; end: number }> = [];
    let open: number | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (line.includes("BEGIN STUDENT TODO")) open = i + 1;
      if (line.includes("END STUDENT TODO") && open != null) {
        const end = i + 1;
        if (end >= open) ranges.push({ start: open, end });
        open = null;
      }
    }

    const decorations = ranges.map((r) => ({
      range: new monaco.Range(r.start, 1, r.end, 1),
      options: {
        isWholeLine: true,
        className: "codem-student-todo-bg",
        linesDecorationsClassName: "codem-student-todo-gutter",
      },
    }));

    todoDecorationsRef.current = editor.deltaDecorations(todoDecorationsRef.current, decorations);
  }

  useEffect(() => {
    updateTodoDecorations(activeCode);
  }, [activeFilename, activeCode]);

  // Terminal output from the last run/check
  const terminalStdout = feedback?.result
    ? stripAnsi((feedback.result as any).stdout ?? "")
    : "";
  const terminalStderr = feedback?.result
    ? normalizeDiagnostics((feedback.result as any).stderr ?? "")
    : "";
  const hasTerminalOutput = Boolean(terminalStdout || terminalStderr);

  // Terminal resize
  const termDragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  return (
    <div className="flex h-full flex-col">
      {/* File tabs bar */}
      <div className="flex items-center justify-between gap-2 border-b border-slate-200 pb-2">
        <div className="flex items-center gap-1 overflow-x-auto">
          {Object.keys(files).map((filename) => {
            const active = activeFilename === filename;
            const deletable = isFileDeletable(filename);
            const role = fileRoles[filename];
            return (
              <div key={filename} className="group relative flex items-center">
                <button
                  type="button"
                  onClick={() => onFileSelect(filename)}
                  className={`flex items-center gap-1.5 rounded-t-lg border border-b-0 px-3 py-1.5 text-xs font-medium transition ${
                    active
                      ? "border-slate-200 bg-white text-slate-900"
                      : "border-transparent bg-slate-100 text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                  }`}
                >
                  <FileIcon language={selectedLanguage} />
                  {filename}
                  {role === "readonly" && (
                    <span className="ml-1 text-[9px] font-semibold uppercase text-slate-400">RO</span>
                  )}
                  {role === "entry" && (
                    <span className="ml-1 text-[9px] font-semibold uppercase text-blue-400">ENTRY</span>
                  )}
                </button>
                {deletable && (
                  <button
                    type="button"
                    title="Delete file"
                    className="absolute -right-1 -top-1 hidden h-4 w-4 items-center justify-center rounded-full border border-slate-200 bg-white text-[10px] font-bold text-slate-400 hover:bg-rose-50 hover:text-rose-500 group-hover:flex"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onDeleteFile(filename);
                    }}
                  >
                    x
                  </button>
                )}
              </div>
            );
          })}
          <button
            onClick={onAddFile}
            className="ml-1 rounded-lg border border-dashed border-slate-300 px-2.5 py-1 text-[11px] font-medium text-slate-500 hover:border-slate-400 hover:text-slate-700"
          >
            + File
          </button>
        </div>
      </div>

      {/* No main() warning */}
      {(selectedLanguage === "java" || selectedLanguage === "cpp") && !canRunMain && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 mt-2">
          No <span className="font-mono">main()</span> in{" "}
          <span className="font-mono">{entryFile}</span>. Use{" "}
          <span className="font-semibold">Check Code</span> to run tests, or add a{" "}
          <span className="font-mono">main()</span> entrypoint.
        </div>
      )}

      {/* Editor area */}
      <div
        className="flex-1 min-h-0 overflow-hidden rounded-lg border border-slate-200 bg-slate-950 mt-2"
        style={terminalOpen && hasTerminalOutput ? { marginBottom: 0 } : {}}
      >
        <Editor
          height="100%"
          language={selectedLanguage}
          value={activeCode}
          onMount={(editor, monaco) => {
            editorRef.current = editor;
            monacoRef.current = monaco;
            updateTodoDecorations(activeCode);
          }}
          onChange={(value) => {
            const next = value ?? "";
            if (isActiveReadonly) return;
            onCodeChange(activeFilename, next);
          }}
          theme="vs-dark"
          options={{
            fontSize: 14,
            minimap: { enabled: false },
            readOnly: isActiveReadonly,
            scrollBeyondLastLine: false,
            padding: { top: 8, bottom: 8 },
          }}
        />
      </div>

      {/* Action bar */}
      <div className="flex items-center justify-between gap-2 border-t border-slate-200 pt-3 mt-2">
        <div className="flex items-center gap-2">
          <button
            onClick={onRun}
            disabled={
              running ||
              submitting ||
              selectedLanguage === "sql" ||
              (!canRunMain && selectedLanguage !== "python")
            }
            className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50 transition"
          >
            {running ? (
              <span className="flex items-center gap-1.5">
                <LoadingDot /> Running...
              </span>
            ) : (
              `Run Code`
            )}
          </button>
          <button
            onClick={onCheckCode}
            disabled={submitting || running}
            className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50 transition"
          >
            {submitting ? (
              <span className="flex items-center gap-1.5">
                <LoadingDot /> Checking...
              </span>
            ) : (
              "Check Code"
            )}
          </button>
        </div>
        <button
          onClick={() => setTerminalOpen((v) => !v)}
          className="rounded-lg border border-slate-200 px-3 py-1.5 text-[11px] font-medium text-slate-500 hover:bg-slate-50"
        >
          {terminalOpen ? "Hide Terminal" : "Show Terminal"}
        </button>
      </div>

      {/* Terminal output */}
      {terminalOpen && (
        <div
          className="mt-2 flex flex-col rounded-lg border border-slate-200 bg-slate-950"
          style={{ height: terminalHeight }}
        >
          {/* Terminal resize handle */}
          <div
            className="group flex h-[6px] shrink-0 cursor-row-resize items-center"
            onPointerDown={(e) => {
              e.preventDefault();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              termDragRef.current = { startY: e.clientY, startHeight: terminalHeight };
            }}
            onPointerMove={(e) => {
              if (!termDragRef.current) return;
              const delta = termDragRef.current.startY - e.clientY;
              setTerminalHeight(Math.max(80, Math.min(400, termDragRef.current.startHeight + delta)));
            }}
            onPointerUp={() => { termDragRef.current = null; }}
            onPointerCancel={() => { termDragRef.current = null; }}
          >
            <div className="mx-auto h-[2px] w-8 rounded-full bg-slate-700 group-hover:bg-slate-500" />
          </div>

          <div className="flex items-center justify-between border-b border-slate-800 px-3 py-1.5">
            <span className="text-[11px] font-semibold text-slate-400">Terminal Output</span>
            {hasTerminalOutput && (
              <span className="text-[10px] text-slate-500">
                {feedback?.kind === "run" ? "Run" : "Check"} output
              </span>
            )}
          </div>
          <div className="flex-1 min-h-0 overflow-auto px-3 py-2">
            {!hasTerminalOutput ? (
              <p className="font-mono text-[11px] text-slate-500">
                Run or check your code to see output here.
              </p>
            ) : (
              <>
                {terminalStdout && (
                  <pre className="font-mono text-[11px] text-green-400 whitespace-pre-wrap">
                    {terminalStdout}
                  </pre>
                )}
                {terminalStderr && (
                  <pre className="font-mono text-[11px] text-rose-400 whitespace-pre-wrap mt-1">
                    {terminalStderr}
                  </pre>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function FileIcon({ language }: { language: LanguageId }) {
  const colors: Record<string, string> = {
    java: "text-orange-400",
    python: "text-blue-400",
    cpp: "text-purple-400",
    sql: "text-teal-400",
  };
  return (
    <span className={`text-[10px] ${colors[language] ?? "text-slate-400"}`}>
      {language === "java" ? "J" : language === "python" ? "Py" : language === "cpp" ? "C+" : "SQL"}
    </span>
  );
}

function LoadingDot() {
  return (
    <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
  );
}
