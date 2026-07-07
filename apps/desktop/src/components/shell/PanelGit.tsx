import { useState } from "react";
import { gitCommit, gitStage, gitUnstage } from "../../api";
import type { GitFileStatus, GitStatus } from "../../types";
import { PanelHead } from "./LeftPanel";
import { ShellIcon } from "./ShellIcon";

interface PanelGitProps {
  vaultRoot: string;
  /** Shared snapshot owned by Dashboard — the same object drives the
   *  rail badge and the titlebar `±N`, so the three can't disagree. */
  status: GitStatus | null;
  /** Ask Dashboard to re-fetch the snapshot after a mutation. */
  onRefetch: () => void;
  onOpenFile: (path: string) => void;
  /** Full source-control view in the center (diffs, history). */
  onOpenFullView: () => void;
}

/**
 * Vault git panel: commit box, Staged / Changes sections. Stage and
 * unstage are per-row affordances; the commit is always an explicit
 * button press (the IDE never auto-commits — that's the safety model
 * for agent writes, see PROJECT_BRIEF).
 */
export function PanelGit({
  vaultRoot,
  status,
  onRefetch,
  onOpenFile,
  onOpenFullView,
}: PanelGitProps) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const staged = status?.files.filter((f) => f.staged) ?? [];
  const changes =
    status?.files.filter((f) => f.unstaged || f.untracked) ?? [];

  const run = async (op: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await op();
      onRefetch();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const onCommit = () =>
    run(async () => {
      await gitCommit(vaultRoot, message.trim());
      setMessage("");
    });

  return (
    <div className="ide-panel" aria-label="Source Control">
      <PanelHead title="Source Control" count="vault">
        <button
          type="button"
          className="hbtn"
          title="Diffs & history"
          onClick={onOpenFullView}
        >
          <ShellIcon name="history" size={15} />
        </button>
      </PanelHead>

      {!status || !status.isGitRepo ? (
        <p className="ide-panel-hint">
          The vault folder is not a git repository. Run <code>git init</code>{" "}
          to track it.
        </p>
      ) : (
        <>
          <div
            style={{
              padding: "10px 12px",
              borderBottom: "1px solid var(--border-soft)",
            }}
          >
            <textarea
              className="ide-textarea"
              rows={2}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Commit message"
              aria-label="Commit message"
            />
            <button
              type="button"
              className="ide-btn primary"
              style={{ width: "100%", justifyContent: "center", marginTop: 8 }}
              disabled={busy || staged.length === 0 || message.trim() === ""}
              onClick={() => void onCommit()}
            >
              ✓ Commit {staged.length} staged
            </button>
            {error && (
              <div
                role="alert"
                style={{
                  marginTop: 8,
                  fontSize: 11,
                  color: "var(--err)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {error}
              </div>
            )}
          </div>

          <div className="ide-panel-body">
            <div className="ide-secline">
              <span>Staged</span>
              <span className="grow" />
              <span>{staged.length}</span>
            </div>
            {staged.map((f) => (
              <FileRow
                key={"s:" + f.path}
                file={f}
                staged
                busy={busy}
                onOpen={onOpenFile}
                onToggle={() => void run(() => gitUnstage(vaultRoot, [f.path]))}
              />
            ))}
            <div className="ide-secline">
              <span>Changes</span>
              <span className="grow" />
              <span>{changes.length}</span>
            </div>
            {changes.map((f) => (
              <FileRow
                key={"c:" + f.path}
                file={f}
                staged={false}
                busy={busy}
                onOpen={onOpenFile}
                onToggle={() => void run(() => gitStage(vaultRoot, [f.path]))}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface FileRowProps {
  file: GitFileStatus;
  staged: boolean;
  busy: boolean;
  onOpen: (path: string) => void;
  onToggle: () => void;
}

function FileRow({ file, staged, busy, onOpen, onToggle }: FileRowProps) {
  const letter = staged
    ? file.index
    : file.untracked
      ? "U"
      : file.worktree;
  const tone =
    letter === "M"
      ? "var(--warn)"
      : letter === "D"
        ? "var(--err)"
        : "var(--ok)";
  const openable = file.path.toLowerCase().endsWith(".md") && letter !== "D";

  return (
    <div
      className="ide-row"
      style={{ fontFamily: "var(--mono)", fontSize: 11.5, gap: 6 }}
    >
      <button
        type="button"
        className="r-txt ide-rtl-path"
        style={{ cursor: openable ? "pointer" : "default" }}
        onClick={openable ? () => onOpen(file.path) : undefined}
        title={file.path}
      >
        {file.path}
      </button>
      <button
        type="button"
        onClick={onToggle}
        disabled={busy}
        title={staged ? "Unstage" : "Stage"}
        aria-label={(staged ? "Unstage " : "Stage ") + file.path}
        style={{ color: "var(--muted)", width: 14, textAlign: "center" }}
      >
        {staged ? "−" : "+"}
      </button>
      <span
        style={{ color: tone, fontWeight: 700, width: 14, textAlign: "center" }}
      >
        {letter}
      </span>
    </div>
  );
}
