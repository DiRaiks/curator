//! Vault-scoped git operations: status, diff, stage/unstage, commit, log.
//!
//! This is the read-AND-write counterpart to [`crate::source_repo`], which
//! is deliberately read-only and aimed at a *project's* `local_path`. This
//! module powers the in-app Source Control panel for the **vault itself**
//! so the user can review and commit Markdown edits without leaving Curator.
//!
//! Everything shells out to the `git` CLI (no `git2`/`libgit2` dependency —
//! see `AGENTS.md` supply-chain policy). Arguments are always passed as an
//! argv array to `Command`, never through a shell, so a malicious path or
//! commit message can't inject extra flags or commands. Callers are
//! responsible for validating that `repo` is a path the user is allowed to
//! act on (the Tauri layer canonicalizes the open vault root before calling).
//!
//! Design constraint carried over from the project brief: the IDE never
//! *auto*-commits. Every mutating call here is the direct result of an
//! explicit user action (stage checkbox, Commit button).

use std::fmt;
use std::path::Path;
use std::process::Command;

use serde::Serialize;

/// Failure modes for a git operation. Mapped to a plain `String` at the
/// Tauri boundary; kept as an enum here so tests can assert on the variant.
/// `#[non_exhaustive]` so adding a variant later isn't a breaking change for
/// any exhaustive `match` on it.
#[derive(Debug)]
#[non_exhaustive]
pub enum GitError {
    /// `git` binary not found / not executable.
    GitUnavailable(String),
    /// Path exists but is not inside a git work tree.
    NotGitRepo,
    /// A path argument from the caller escapes the repo root (absolute,
    /// `..`-traversal, or flag-shaped). Rejected before reaching git.
    UnsafePath(String),
    /// `git` ran but exited non-zero. Carries trimmed stderr (or stdout
    /// when stderr is empty) so the UI can show what git complained about.
    CommandFailed(String),
}

impl fmt::Display for GitError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GitError::GitUnavailable(e) => write!(f, "git is not available: {e}"),
            GitError::NotGitRepo => write!(f, "not a git repository"),
            GitError::UnsafePath(p) => write!(f, "unsafe path rejected: {p}"),
            GitError::CommandFailed(msg) => write!(f, "{msg}"),
        }
    }
}

impl std::error::Error for GitError {}

/// One changed path in the working tree, mirroring a `git status --porcelain`
/// row. `staged`/`unstaged`/`untracked` are derived from the raw `index` /
/// `worktree` status chars so the frontend doesn't have to know git's
/// two-letter code semantics.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    /// Working-tree path (the destination/new path for renames), relative to
    /// the repo root, slash-separated as git reports it.
    pub path: String,
    /// Original path for a rename/copy entry; `None` otherwise.
    pub orig_path: Option<String>,
    /// Index (staged) status char from the porcelain `X` column, as a
    /// one-char string. `" "` (space) means unmodified in the index.
    pub index: String,
    /// Working-tree status char from the porcelain `Y` column. `" "` means
    /// unmodified in the work tree.
    pub worktree: String,
    /// There is a staged change for this path (`X` is meaningful).
    pub staged: bool,
    /// There is an unstaged change for this path (`Y` is meaningful).
    pub unstaged: bool,
    /// The path is untracked (`??`).
    pub untracked: bool,
}

/// Snapshot of the vault repo's working-tree state, plus enough branch
/// context for the panel header. Distinct from
/// [`crate::source_repo::SourceRepoInspection`] which targets project repos
/// and is read-only.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    pub is_git_repo: bool,
    pub branch: Option<String>,
    /// False on an unborn branch (a fresh `git init` with no commits yet) —
    /// the UI uses this to disable "view diff against HEAD" affordances and
    /// to label the first commit appropriately.
    pub has_commits: bool,
    /// No staged or unstaged changes (untracked included).
    pub clean: bool,
    pub files: Vec<GitFileStatus>,
}

/// One entry from `git log`, shaped for the history list.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub short_hash: String,
    pub subject: String,
    pub author: String,
    /// e.g. "3 days ago" — `%cr` committer relative date.
    pub relative_date: String,
    /// Committer date as unix seconds (`%ct`), for client-side sorting /
    /// absolute-time tooltips.
    pub unix_secs: i64,
}

/// Result of a successful commit.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitOutcome {
    pub short_hash: String,
}

/// Output of one `git` invocation. We keep stdout/stderr/status together so
/// callers can decide what counts as success (e.g. `diff --no-index` exits 1
/// when there *is* a diff, which is not an error for us).
struct GitOutput {
    success: bool,
    /// Process exit code, or `None` if the process was killed by a signal.
    /// Callers that distinguish "diff present" (1) from "real error" (128)
    /// branch on this rather than on stderr content.
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

/// Run `git <args>` in `repo`. Never goes through a shell; args are passed
/// verbatim. Returns the captured output, or [`GitError::GitUnavailable`] if
/// the binary can't be spawned at all.
fn run_git(repo: &Path, args: &[&str]) -> Result<GitOutput, GitError> {
    let output = Command::new("git")
        .args(args)
        .current_dir(repo)
        .output()
        .map_err(|e| GitError::GitUnavailable(e.to_string()))?;
    Ok(GitOutput {
        success: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// Reject a caller-supplied path before it reaches `git`.
///
/// Defense-in-depth containment: the Source Control panel is meant to act on
/// files *inside* the vault only, but the frontend webview is the trust
/// boundary, so a tampered/compromised caller could send an absolute path,
/// a `..`-traversal, or a flag-shaped string. We reject all three:
///
/// - leading `-` — even though every call site uses `--`, `git diff
///   --no-index` and future call sites are easy to get wrong; a flat ban is
///   cheap insurance against option injection.
/// - absolute paths and `..` components — `git add -- <p>` / `diff --no-index
///   <p>` happily operate on files outside the work tree, which would let a
///   crafted path stage or *read* (`--no-index` dumps full contents) files
///   anywhere on disk.
///
/// Untracked/tracked files inside the vault are always plain relative paths,
/// so well-formed input always passes.
fn validate_repo_relative(rel: &str) -> Result<(), GitError> {
    if rel.is_empty() || rel.starts_with('-') {
        return Err(GitError::UnsafePath(rel.to_string()));
    }
    let path = Path::new(rel);
    if path.is_absolute() {
        return Err(GitError::UnsafePath(rel.to_string()));
    }
    for comp in path.components() {
        if matches!(
            comp,
            std::path::Component::ParentDir | std::path::Component::Prefix(_)
        ) {
            return Err(GitError::UnsafePath(rel.to_string()));
        }
    }
    Ok(())
}

/// Run a git command that must succeed; map a non-zero exit to
/// [`GitError::CommandFailed`] with the trimmed stderr (falling back to
/// stdout) as the message.
fn run_git_checked(repo: &Path, args: &[&str]) -> Result<String, GitError> {
    let out = run_git(repo, args)?;
    if !out.success {
        let msg = pick_error_message(&out);
        return Err(GitError::CommandFailed(msg));
    }
    Ok(out.stdout)
}

fn pick_error_message(out: &GitOutput) -> String {
    let stderr = out.stderr.trim();
    if !stderr.is_empty() {
        return stderr.to_string();
    }
    let stdout = out.stdout.trim();
    if !stdout.is_empty() {
        return stdout.to_string();
    }
    "git command failed with no output".to_string()
}

fn is_git_repo(repo: &Path) -> bool {
    matches!(
        run_git(repo, &["rev-parse", "--is-inside-work-tree"]),
        Ok(out) if out.success && out.stdout.trim() == "true"
    )
}

/// Working-tree status for the vault repo. Returns an `is_git_repo: false`
/// snapshot (rather than an error) when `repo` isn't a git work tree, so the
/// panel can render a calm "not a git repo" empty state.
pub fn status(repo: &Path) -> Result<GitStatus, GitError> {
    if !is_git_repo(repo) {
        return Ok(GitStatus {
            is_git_repo: false,
            branch: None,
            has_commits: false,
            clean: true,
            files: Vec::new(),
        });
    }

    let branch = run_git(repo, &["branch", "--show-current"])
        .ok()
        .filter(|o| o.success)
        .map(|o| o.stdout.trim().to_string())
        .filter(|s| !s.is_empty());

    // `rev-parse --verify HEAD` fails on an unborn branch (no commits yet).
    let has_commits = run_git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .map(|o| o.success)
        .unwrap_or(false);

    // `--untracked-files=all` is load-bearing: without it git collapses an
    // untracked subtree to its top directory (`?? a/b/`, trailing slash), so
    // a brand-new file in a new folder would surface as a *directory* path
    // that can't be diffed, staged precisely, or opened. `-uall` lists every
    // untracked file individually, so `path` is always a real file.
    let raw = run_git_checked(
        repo,
        &["status", "--porcelain", "--untracked-files=all", "-z"],
    )?;
    let files = parse_status_z(&raw);
    let clean = files.is_empty();

    Ok(GitStatus {
        is_git_repo: true,
        branch,
        has_commits,
        clean,
        files,
    })
}

/// Parse the NUL-delimited `git status --porcelain -z` output.
///
/// Each record is `XY<space>PATH`. Rename/copy records (X or Y is `R`/`C`)
/// are followed by a second NUL-delimited token: the original path. With
/// `-z`, the new (work-tree) path comes first, the original second — we keep
/// the new path as `path` (correct target for `git add`/`git diff`) and
/// stash the original in `orig_path`.
fn parse_status_z(raw: &str) -> Vec<GitFileStatus> {
    let mut out = Vec::new();
    // `split` on NUL yields a trailing empty string after the final
    // terminator; `filter`/length checks below drop it.
    let mut tokens = raw.split('\0');
    while let Some(token) = tokens.next() {
        // A valid record is at least `XY ` + one path char.
        if token.len() < 4 {
            continue;
        }
        let bytes = token.as_bytes();
        // Porcelain v1 records are always `XY<space>PATH`. If byte 2 isn't a
        // space the line is a format we don't understand (a future porcelain
        // variant, a submodule line, etc.) — skip it rather than mis-slice.
        if bytes[2] != b' ' {
            debug_assert!(false, "unexpected porcelain record: {token:?}");
            continue;
        }
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let path = token[3..].to_string();

        let is_rename_or_copy = matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C');
        let orig_path = if is_rename_or_copy {
            tokens
                .next()
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
        } else {
            None
        };

        let untracked = x == '?' && y == '?';
        let staged = !untracked && x != ' ';
        let unstaged = untracked || y != ' ';

        out.push(GitFileStatus {
            path,
            orig_path,
            index: x.to_string(),
            worktree: y.to_string(),
            staged,
            unstaged,
            untracked,
        });
    }
    out
}

/// Unified diff for a single path.
///
/// `staged = true` diffs the index against HEAD (`git diff --cached`);
/// `false` diffs the work tree against the index (`git diff`). When the
/// unstaged diff is empty because the file is untracked, falls back to
/// `git diff --no-index` against an empty tree so a brand-new file still
/// shows its full contents as additions.
pub fn diff(repo: &Path, path: &str, staged: bool) -> Result<String, GitError> {
    if !is_git_repo(repo) {
        return Err(GitError::NotGitRepo);
    }
    validate_repo_relative(path)?;

    if staged {
        return run_git_checked(repo, &["diff", "--cached", "--", path]);
    }

    let tracked = run_git_checked(repo, &["diff", "--", path])?;
    if !tracked.trim().is_empty() {
        return Ok(tracked);
    }

    // Untracked file: `git diff` reports nothing. `--no-index` against
    // /dev/null renders the whole file as additions.
    let out = run_git(repo, &["diff", "--no-index", "--", "/dev/null", path])?;
    // `git diff --no-index` OVERLOADS exit 1: it's used both for "a difference
    // is present" (the normal case here) AND for some failures like "Could not
    // access <path>" when the file is missing. So the exit code alone can't
    // tell them apart — stderr is the discriminator. Treat as success when:
    //   - exit 0 (identical / empty file), or
    //   - exit 1 with NO error text (a genuine additions diff).
    // Anything with stderr, or any other exit code, is a real failure.
    if out.success || (out.code == Some(1) && out.stderr.trim().is_empty()) {
        Ok(out.stdout)
    } else {
        Err(GitError::CommandFailed(pick_error_message(&out)))
    }
}

/// Stage the given paths (`git add -- <paths>`). Empty `paths` is a no-op.
pub fn stage(repo: &Path, paths: &[String]) -> Result<(), GitError> {
    if paths.is_empty() {
        return Ok(());
    }
    for p in paths {
        validate_repo_relative(p)?;
    }
    let mut args: Vec<&str> = vec!["add", "--"];
    args.extend(paths.iter().map(String::as_str));
    run_git_checked(repo, &args)?;
    Ok(())
}

/// Stage every change in the work tree, including deletions and untracked
/// files (`git add -A`).
pub fn stage_all(repo: &Path) -> Result<(), GitError> {
    run_git_checked(repo, &["add", "-A"])?;
    Ok(())
}

/// Unstage the given paths, leaving working-tree edits intact.
///
/// Uses `git restore --staged` when there's a HEAD to restore from, and
/// falls back to `git rm --cached` on an unborn branch (no commits yet),
/// where `restore` has nothing to restore against.
pub fn unstage(repo: &Path, paths: &[String]) -> Result<(), GitError> {
    if paths.is_empty() {
        return Ok(());
    }
    for p in paths {
        validate_repo_relative(p)?;
    }

    let has_commits = run_git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .map(|o| o.success)
        .unwrap_or(false);

    if has_commits {
        let mut args: Vec<&str> = vec!["restore", "--staged", "--"];
        args.extend(paths.iter().map(String::as_str));
        run_git_checked(repo, &args)?;
    } else {
        let mut args: Vec<&str> = vec!["rm", "--cached", "-r", "--"];
        args.extend(paths.iter().map(String::as_str));
        run_git_checked(repo, &args)?;
    }
    Ok(())
}

/// Commit whatever is currently staged with `message`. Does **not** stage
/// anything itself — the caller stages explicitly first. Signing is left to
/// the user's git config (`commit.gpgsign`, `gpg.format`, etc.); we neither
/// force `-S` nor pass `--no-gpg-sign`, so a user who signs commits keeps
/// signing them.
///
/// Returns the short hash of the new commit. Surfaces git's own error (e.g.
/// "nothing to commit") via [`GitError::CommandFailed`].
pub fn commit(repo: &Path, message: &str) -> Result<CommitOutcome, GitError> {
    if !is_git_repo(repo) {
        return Err(GitError::NotGitRepo);
    }
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err(GitError::CommandFailed(
            "commit message must not be empty".to_string(),
        ));
    }

    // `-m` takes the message as a single argv element — no shell, no
    // interpolation, so newlines and quotes in the message are safe.
    run_git_checked(repo, &["commit", "-m", trimmed])?;

    let short_hash = run_git_checked(repo, &["rev-parse", "--short", "HEAD"])?
        .trim()
        .to_string();
    Ok(CommitOutcome { short_hash })
}

/// Recent commits on the current branch, newest first. `limit` is clamped to
/// a sane ceiling so a pathological caller can't ask git to render the whole
/// history into memory.
pub fn log(repo: &Path, limit: usize) -> Result<Vec<CommitInfo>, GitError> {
    if !is_git_repo(repo) {
        return Err(GitError::NotGitRepo);
    }
    let has_commits = run_git(repo, &["rev-parse", "--verify", "--quiet", "HEAD"])
        .map(|o| o.success)
        .unwrap_or(false);
    if !has_commits {
        return Ok(Vec::new());
    }

    let capped = limit.clamp(1, 200);
    let count = format!("-{capped}");
    // Field separator is a unit-separator byte (0x1f); record separator is a
    // NUL (`-z`). The free-text `%s` (subject) is placed LAST and parsed with
    // `splitn(5, …)` so a stray 0x1f *inside* a commit subject can't shift the
    // fixed fields (hash/author/date/timestamp) — the subject just absorbs it.
    let format = "--format=%h\u{1f}%an\u{1f}%cr\u{1f}%ct\u{1f}%s";
    let raw = run_git_checked(repo, &["log", &count, "-z", format])?;

    let mut out = Vec::new();
    for record in raw.split('\0') {
        if record.trim().is_empty() {
            continue;
        }
        let mut fields = record.splitn(5, '\u{1f}');
        let short_hash = fields.next().unwrap_or("").trim().to_string();
        let author = fields.next().unwrap_or("").to_string();
        let relative_date = fields.next().unwrap_or("").to_string();
        let unix_secs = fields
            .next()
            .and_then(|s| s.trim().parse::<i64>().ok())
            .unwrap_or(0);
        let subject = fields.next().unwrap_or("").to_string();
        if short_hash.is_empty() {
            continue;
        }
        out.push(CommitInfo {
            short_hash,
            subject,
            author,
            relative_date,
            unix_secs,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// Create a fresh temp dir and `git init` it with a deterministic
    /// identity + main branch, so commits don't depend on the host's git
    /// config.
    fn temp_git_repo(tag: &str) -> PathBuf {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let pid = std::process::id();
        let dir = std::env::temp_dir().join(format!("vw-git-{tag}-{pid}-{nanos}"));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        run_git_checked(&dir, &["init", "-q", "-b", "main"]).expect("git init");
        run_git_checked(&dir, &["config", "user.email", "test@example.com"]).unwrap();
        run_git_checked(&dir, &["config", "user.name", "Test"]).unwrap();
        // Don't let a host `commit.gpgsign=true` block the test commits.
        run_git_checked(&dir, &["config", "commit.gpgsign", "false"]).unwrap();
        dir
    }

    fn write(dir: &Path, rel: &str, contents: &str) {
        let p = dir.join(rel);
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(p, contents).unwrap();
    }

    #[test]
    fn status_on_non_git_dir_reports_not_repo() {
        let dir = std::env::temp_dir().join(format!("vw-git-nonrepo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let s = status(&dir).expect("status should not error on non-repo");
        assert!(!s.is_git_repo);
        assert!(s.clean);
        assert!(s.files.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_classifies_untracked_staged_and_unstaged() {
        let dir = temp_git_repo("status-classify");
        write(&dir, "committed.md", "v1");
        stage(&dir, &["committed.md".to_string()]).unwrap();
        commit(&dir, "init").unwrap();

        // Modify a tracked file but don't stage it.
        write(&dir, "committed.md", "v2");
        // Add a new file and stage it.
        write(&dir, "staged.md", "new");
        stage(&dir, &["staged.md".to_string()]).unwrap();
        // Add an untracked file.
        write(&dir, "untracked.md", "loose");

        let s = status(&dir).unwrap();
        assert!(s.is_git_repo);
        assert!(s.has_commits);
        assert!(!s.clean);

        let by_path = |p: &str| s.files.iter().find(|f| f.path == p).cloned();

        let modified = by_path("committed.md").expect("modified file present");
        assert!(modified.unstaged, "tracked edit should be unstaged");
        assert!(!modified.staged);
        assert!(!modified.untracked);

        let staged = by_path("staged.md").expect("staged file present");
        assert!(staged.staged, "newly added file should be staged");
        assert!(!staged.untracked);

        let untracked = by_path("untracked.md").expect("untracked file present");
        assert!(untracked.untracked);
        assert!(untracked.unstaged);
        assert!(!untracked.staged);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn status_lists_nested_untracked_file_not_collapsed_dir() {
        // Regression: git collapses an untracked subtree to its top dir
        // (`?? a/b/`) unless `--untracked-files=all` is passed. A new file in
        // a new folder must surface as the file, never the directory — else
        // staging it then unstaging it (which re-collapses) leaves a
        // directory path that breaks diff/open.
        let dir = temp_git_repo("untracked-nested");
        write(&dir, "seed.md", "seed");
        stage_all(&dir).unwrap();
        commit(&dir, "init").unwrap();

        let rel = "a/b/c/note.md";
        write(&dir, rel, "fresh");

        let s = status(&dir).unwrap();
        let entry = s
            .files
            .iter()
            .find(|f| f.path == rel)
            .unwrap_or_else(|| panic!("expected {rel}, got {:?}", s.files));
        assert!(entry.untracked);
        assert!(!entry.path.ends_with('/'), "must not be a collapsed dir");

        // Stage → unstage roundtrip must keep the same file path, not
        // collapse back to the directory.
        stage(&dir, &[rel.to_string()]).unwrap();
        unstage(&dir, &[rel.to_string()]).unwrap();
        let after = status(&dir).unwrap();
        assert!(
            after.files.iter().any(|f| f.path == rel),
            "path should survive stage/unstage, got {:?}",
            after.files
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stage_then_unstage_roundtrip() {
        let dir = temp_git_repo("stage-roundtrip");
        write(&dir, "a.md", "1");
        stage(&dir, &["a.md".to_string()]).unwrap();
        commit(&dir, "init").unwrap();

        write(&dir, "a.md", "2");
        stage(&dir, &["a.md".to_string()]).unwrap();
        assert!(status(&dir).unwrap().files.iter().any(|f| f.staged));

        unstage(&dir, &["a.md".to_string()]).unwrap();
        let s = status(&dir).unwrap();
        let f = s.files.iter().find(|f| f.path == "a.md").unwrap();
        assert!(!f.staged, "should be unstaged after restore");
        assert!(f.unstaged, "edit should remain in work tree");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn commit_returns_short_hash_and_clears_tree() {
        let dir = temp_git_repo("commit-hash");
        write(&dir, "a.md", "1");
        stage_all(&dir).unwrap();
        let outcome = commit(&dir, "first commit").unwrap();
        assert!(!outcome.short_hash.is_empty());
        assert!(outcome.short_hash.chars().all(|c| c.is_ascii_hexdigit()));
        assert!(status(&dir).unwrap().clean, "tree clean after commit");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn commit_with_empty_message_is_rejected() {
        let dir = temp_git_repo("commit-empty-msg");
        write(&dir, "a.md", "1");
        stage_all(&dir).unwrap();
        let err = commit(&dir, "   ").unwrap_err();
        assert!(matches!(err, GitError::CommandFailed(_)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn commit_with_nothing_staged_errors() {
        let dir = temp_git_repo("commit-nothing");
        write(&dir, "a.md", "1");
        stage_all(&dir).unwrap();
        commit(&dir, "init").unwrap();
        // Nothing staged now.
        let err = commit(&dir, "empty").unwrap_err();
        assert!(matches!(err, GitError::CommandFailed(_)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn diff_shows_unstaged_edit() {
        let dir = temp_git_repo("diff-unstaged");
        write(&dir, "a.md", "line one\n");
        stage_all(&dir).unwrap();
        commit(&dir, "init").unwrap();
        write(&dir, "a.md", "line one\nline two\n");

        let d = diff(&dir, "a.md", false).unwrap();
        assert!(
            d.contains("+line two"),
            "diff should show the added line: {d}"
        );

        // Staged diff is empty until we stage.
        assert!(diff(&dir, "a.md", true).unwrap().trim().is_empty());
        stage_all(&dir).unwrap();
        assert!(diff(&dir, "a.md", true).unwrap().contains("+line two"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn diff_renders_untracked_file_as_additions() {
        let dir = temp_git_repo("diff-untracked");
        write(&dir, "a.md", "v1");
        stage_all(&dir).unwrap();
        commit(&dir, "init").unwrap();
        write(&dir, "fresh.md", "brand new content\n");

        let d = diff(&dir, "fresh.md", false).unwrap();
        assert!(
            d.contains("brand new content"),
            "untracked diff should show file contents: {d}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn log_returns_commits_newest_first() {
        let dir = temp_git_repo("log-order");
        write(&dir, "a.md", "1");
        stage_all(&dir).unwrap();
        commit(&dir, "first").unwrap();
        write(&dir, "b.md", "2");
        stage_all(&dir).unwrap();
        commit(&dir, "second").unwrap();

        let entries = log(&dir, 10).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].subject, "second");
        assert_eq!(entries[1].subject, "first");
        assert!(!entries[0].short_hash.is_empty());
        assert!(entries[0].unix_secs > 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn log_on_unborn_branch_is_empty() {
        let dir = temp_git_repo("log-unborn");
        let entries = log(&dir, 10).unwrap();
        assert!(entries.is_empty());
        let s = status(&dir).unwrap();
        assert!(s.is_git_repo);
        assert!(!s.has_commits);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn diff_on_path_that_does_not_exist_errors() {
        let dir = temp_git_repo("diff-missing");
        write(&dir, "a.md", "1");
        stage_all(&dir).unwrap();
        commit(&dir, "init").unwrap();
        // Neither tracked nor present on disk → tracked diff is empty, the
        // `--no-index` fallback exits 128. Must surface as an error, not Ok.
        let err = diff(&dir, "nope.md", false).unwrap_err();
        assert!(matches!(err, GitError::CommandFailed(_)));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn path_traversal_and_flag_args_are_rejected() {
        let dir = temp_git_repo("path-guard");
        write(&dir, "a.md", "1");
        stage_all(&dir).unwrap();
        commit(&dir, "init").unwrap();

        for bad in ["../outside.md", "/etc/passwd", "-x", "--no-index", ""] {
            assert!(
                matches!(diff(&dir, bad, false), Err(GitError::UnsafePath(_))),
                "diff should reject {bad:?}"
            );
            assert!(
                matches!(
                    stage(&dir, &[bad.to_string()]),
                    Err(GitError::UnsafePath(_))
                ),
                "stage should reject {bad:?}"
            );
            assert!(
                matches!(
                    unstage(&dir, &[bad.to_string()]),
                    Err(GitError::UnsafePath(_))
                ),
                "unstage should reject {bad:?}"
            );
        }
        // A nested relative path is fine.
        assert!(validate_repo_relative("a/b/c.md").is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn log_subject_with_unit_separator_does_not_corrupt_fields() {
        let dir = temp_git_repo("log-sep");
        write(&dir, "a.md", "1");
        stage_all(&dir).unwrap();
        // A literal 0x1f inside the subject must not shift the fixed fields.
        commit(&dir, "subject\u{1f}with separator").unwrap();
        let entries = log(&dir, 5).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].subject.starts_with("subject"));
        assert!(!entries[0].short_hash.is_empty());
        assert!(entries[0].unix_secs > 0, "timestamp field stayed aligned");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_status_z_handles_rename() {
        // `R` in the index column, NUL-separated new then orig path.
        let raw = "R  new.md\0old.md\0 M other.md\0";
        let files = parse_status_z(raw);
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "new.md");
        assert_eq!(files[0].orig_path.as_deref(), Some("old.md"));
        assert!(files[0].staged);
        assert_eq!(files[1].path, "other.md");
        assert!(files[1].unstaged);
        assert!(!files[1].staged);
    }
}
