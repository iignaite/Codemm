"use client";

import { useActivity } from "@/hooks/useActivity";
import LeftPane from "./components/LeftPane";
import CenterPane from "./components/CenterPane";
import RightPane from "./components/RightPane";

export default function ActivityPage() {
  const {
    activity,
    addFileError,
    addFileInputRef,
    addFileName,
    addFileOpen,
    activeFilename,
    beginDrag,
    canRunMain,
    closeAddFileModal,
    closeDeleteFileModal,
    commitDeleteFile,
    currentStatus,
    deleteFileError,
    deleteFileName,
    deleteFileOpen,
    endDrag,
    entryFile,
    feedback,
    fileRoles,
    files,
    formatTime,
    goHome,
    goToReview,
    handleAddFileClick,
    handleCodeChange,
    handleConfirmAddFile,
    handleDeleteFileClick,
    handleFileSelect,
    handleRun,
    handleRunTests,
    isActiveReadonly,
    isFileDeletable,
    isGuidedActivity,
    layoutRef,
    leftPaneWidth,
    loadError,
    loading,
    onDrag,
    problemIndex,
    problemStatusById,
    rightPaneWidth,
    running,
    selectProblem,
    selectedLanguage,
    selectedProblem,
    selectedProblemId,
    setAddFileError,
    setAddFileName,
    setFeedback,
    submitting,
    testSuite,
    timerMode,
    timerSeconds,
  } = useActivity();

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50 text-slate-900">
        <div className="rounded-lg bg-white px-4 py-3 text-sm shadow">Loading activity...</div>
      </div>
    );
  }

  if (!activity) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50 text-slate-900">
        <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-4 shadow">
          <div className="text-sm font-semibold text-slate-900">Couldn&apos;t open this activity</div>
          <div className="mt-1 text-sm text-slate-600">{loadError ?? "Activity not found."}</div>
          <div className="mt-4 flex gap-2">
            <button onClick={goHome} className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
              Home
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (activity.status === "INCOMPLETE") {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50 text-slate-900">
        <div className="w-full max-w-xl rounded-2xl border border-amber-200 bg-white p-5 shadow">
          <div className="text-sm font-semibold text-slate-900">This activity is incomplete</div>
          <div className="mt-2 text-sm text-slate-600">
            Generation only partially succeeded. Open review mode to inspect the surviving problems and repair or
            discard the incomplete result before using it as a learner activity.
          </div>
          <div className="mt-4 flex gap-2">
            <button
              onClick={goHome}
              className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Home
            </button>
            <button
              onClick={goToReview}
              className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100"
            >
              Open Review
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-full overflow-hidden bg-slate-50 text-slate-900">
      <style jsx global>{`
        .codem-student-todo-bg { background: rgba(250, 204, 21, 0.12); }
        .codem-student-todo-gutter { border-left: 3px solid rgba(250, 204, 21, 0.9); }
      `}</style>

      <div className="flex h-screen w-full flex-col">
        <header className="flex items-center justify-between border-b border-slate-200 bg-white px-4 py-2.5">
          <div className="flex items-center gap-3">
            <button
              onClick={goHome}
              className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              Home
            </button>
            <div className="h-4 w-px bg-slate-200" />
            <div>
              <h1 className="text-sm font-semibold tracking-tight text-slate-900">{activity.title}</h1>
              <p className="text-[11px] text-slate-500">
                {isGuidedActivity ? "Guided" : "Practice"} &middot; {activity.problems.length} problems
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {(activity.status === "DRAFT" || activity.status === "INCOMPLETE") && (
              <button
                onClick={goToReview}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium ${
                  activity.status === "INCOMPLETE"
                    ? "border border-rose-300 bg-rose-50 text-rose-800 hover:bg-rose-100"
                    : "border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100"
                }`}
              >
                {activity.status === "INCOMPLETE" ? "Incomplete" : "Draft"}
              </button>
            )}
            <div className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-700">
              {problemIndex + 1}/{activity.problems.length}
            </div>
            <div
              className={`rounded-lg px-3 py-1.5 text-xs font-mono font-medium ${
                timerMode === "countdown" && timerSeconds < 60
                  ? "bg-rose-50 text-rose-700"
                  : "bg-slate-100 text-slate-700"
              }`}
            >
              {timerMode === "countdown" ? "Left " : ""}
              {formatTime(timerSeconds)}
            </div>
          </div>
        </header>

        <main ref={layoutRef} className="flex flex-1 min-h-0">
          <section
            className="min-h-0 overflow-hidden border-r border-slate-200 bg-white p-4"
            style={{ width: leftPaneWidth }}
          >
            <LeftPane
              problem={selectedProblem}
              problemIndex={problemIndex}
              totalProblems={activity.problems.length}
              status={currentStatus}
            />
          </section>

          <div
            className="group flex w-[8px] shrink-0 cursor-col-resize items-stretch bg-slate-50 hover:bg-blue-50 transition-colors"
            onPointerDown={(event) => beginDrag("left", event)}
            onPointerMove={onDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <div className="mx-auto my-6 w-[2px] rounded-full bg-slate-200 group-hover:bg-blue-400 transition-colors" />
          </div>

          <section className="flex min-h-0 min-w-[520px] flex-1 flex-col bg-white p-4">
            <CenterPane
              files={files}
              fileRoles={fileRoles}
              activeFilename={activeFilename}
              selectedLanguage={selectedLanguage}
              isActiveReadonly={isActiveReadonly}
              canRunMain={canRunMain}
              entryFile={entryFile}
              running={running}
              submitting={submitting}
              feedback={feedback}
              onFileSelect={handleFileSelect}
              onCodeChange={handleCodeChange}
              onRun={handleRun}
              onCheckCode={handleRunTests}
              onAddFile={handleAddFileClick}
              onDeleteFile={handleDeleteFileClick}
              isFileDeletable={isFileDeletable}
            />
          </section>

          <div
            className="group flex w-[8px] shrink-0 cursor-col-resize items-stretch bg-slate-50 hover:bg-blue-50 transition-colors"
            onPointerDown={(event) => beginDrag("right", event)}
            onPointerMove={onDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <div className="mx-auto my-6 w-[2px] rounded-full bg-slate-200 group-hover:bg-blue-400 transition-colors" />
          </div>

          <section
            className="min-h-0 overflow-hidden border-l border-slate-200 bg-white p-4"
            style={{ width: rightPaneWidth }}
          >
            <RightPane
              activity={activity}
              selectedProblemId={selectedProblemId}
              problemStatusById={problemStatusById}
              feedback={feedback}
              selectedLanguage={selectedLanguage}
              testSuite={testSuite}
              onSelectProblem={selectProblem}
              onClearFeedback={() => setFeedback(null)}
              onRunAllTests={handleRunTests}
              submitting={submitting}
            />
          </section>
        </main>
      </div>

      {addFileOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeAddFileModal();
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              closeAddFileModal();
            }
          }}
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-4 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">Add file</div>
                <div className="mt-1 text-xs text-slate-600">
                  {selectedLanguage === "python"
                    ? 'Example: "utils.py"'
                    : selectedLanguage === "cpp"
                      ? 'Example: "helper.hpp"'
                      : 'Example: "Helper.java"'}
                </div>
              </div>
              <button
                type="button"
                className="rounded-lg border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                onClick={closeAddFileModal}
              >
                Close
              </button>
            </div>
            <div className="mt-4">
              <label className="text-xs font-semibold text-slate-700">Filename</label>
              <input
                ref={addFileInputRef}
                className="mt-2 w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-100"
                value={addFileName}
                onChange={(event) => {
                  setAddFileName(event.target.value);
                  if (addFileError) setAddFileError(null);
                }}
                placeholder={selectedLanguage === "python" ? "utils.py" : selectedLanguage === "cpp" ? "helper.hpp" : "Helper.java"}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    handleConfirmAddFile();
                  }
                }}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              {addFileError ? (
                <div className="mt-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{addFileError}</div>
              ) : (
                <div className="mt-2 text-[11px] text-slate-500">Letters, numbers, and underscore only.</div>
              )}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                onClick={closeAddFileModal}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-lg bg-blue-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-blue-700"
                onClick={handleConfirmAddFile}
              >
                Create file
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteFileOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          role="dialog"
          aria-modal="true"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              closeDeleteFileModal();
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              closeDeleteFileModal();
            }
          }}
        >
          <div className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-4 shadow-xl">
            <div className="text-sm font-semibold text-slate-900">Delete file</div>
            <div className="mt-2 text-xs text-slate-600">
              Delete <span className="font-mono">{deleteFileName}</span> from this problem?
            </div>
            {deleteFileError && <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700">{deleteFileError}</div>}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                onClick={closeDeleteFileModal}
              >
                Cancel
              </button>
              <button
                type="button"
                className="rounded-lg bg-rose-600 px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-rose-700"
                onClick={commitDeleteFile}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
