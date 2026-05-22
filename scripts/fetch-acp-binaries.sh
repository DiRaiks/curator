#!/usr/bin/env bash
#
# Fetch pre-built ACP agent assets from the npm registry and place
# them where the Tauri bundler expects:
#
#   apps/desktop/src-tauri/binaries/codex-acp-<target-triple>
#       — codex-acp native binary (172 MB per platform). Tauri's
#         externalBin slot copies it into the .app at bundle time.
#   apps/desktop/src-tauri/resources/acp/node_modules/...
#       — claude-agent-acp JS wrapper + its `@anthropic-ai/claude-agent-sdk`
#         transitive deps (~33 MB). Vendored as a real `node_modules/`
#         tree so the wrapper's runtime `import` walks resolve to the
#         right modules; without this layout Node throws
#         `ERR_MODULE_NOT_FOUND` on the SDK import.
#
# Why this script and not just commit the assets:
#
#  - codex-acp ships as a ~170 MB per-platform binary; committing one
#    per target turns the repo into ~700 MB of opaque blobs.
#  - The claude-agent-acp transitive tree is ~33 MB and changes every
#    upstream release — keeping it out of git keeps the diff signal
#    high and bumps explicit (this script's pinned versions).
#  - npm publishes both with signed manifests + integrity hashes the
#    install step verifies. Pinning + version bump = reproducible
#    fetches without rolling our own signing infra.
#
# Run once per machine after clone, and re-run when the pinned
# versions below are bumped. The Tauri bundler picks the matching
# files at build time using `bundle.resources` + `bundle.externalBin`
# in `tauri.conf.json`.

set -euo pipefail

# --- Pinned versions ---
# Bump deliberately. Agent capabilities (the JSON-RPC method set
# they speak) can shift between minor releases, and our Rust
# ACP-client + frontend renderer must match. Cross-reference against
# `crates/vault-core/src/runner/acp/*.rs` when updating.
CODEX_ACP_VERSION="0.14.0"
CLAUDE_ACP_VERSION="0.37.0"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN_DIR="$REPO_ROOT/apps/desktop/src-tauri/binaries"
RES_DIR="$REPO_ROOT/apps/desktop/src-tauri/resources/acp"
mkdir -p "$BIN_DIR" "$RES_DIR"

# Helper: lay down a vendored node_modules tree under $RES_DIR. We
# install with `--omit=optional` so the optional 208 MB
# `@anthropic-ai/claude-agent-sdk-darwin-arm64` (and siblings)
# stays out — the wrapper falls back to `CLAUDE_CODE_EXECUTABLE` at
# runtime and never resolves the platform binary, so we don't ship it.
install_claude_acp() {
    local stamp="$RES_DIR/.claude-acp.version"
    if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$CLAUDE_ACP_VERSION" ] \
       && [ -d "$RES_DIR/node_modules/@agentclientprotocol/claude-agent-acp" ]; then
        echo "claude-agent-acp $CLAUDE_ACP_VERSION already vendored — skipping fetch."
        return 0
    fi

    echo "Fetching @agentclientprotocol/claude-agent-acp@$CLAUDE_ACP_VERSION..."
    # Stage into a temp dir so a half-failed install doesn't leave a
    # corrupted tree under the real path.
    local staging
    staging="$(mktemp -d)"
    # shellcheck disable=SC2064  # we want $staging expanded now
    trap "rm -rf '$staging'" RETURN
    (
        cd "$staging"
        echo '{"name":"acp-vendor-stage","private":true}' > package.json
        npm install --silent --no-save --omit=optional \
            "@agentclientprotocol/claude-agent-acp@$CLAUDE_ACP_VERSION"
    )

    # Strip test fixtures / source maps / READMEs / AGENTS.md so the
    # final bundled .app stays as small as we can make it. Same
    # filter the dev tree was cleaned with originally.
    find "$staging/node_modules" -name '*.test.*' -delete 2>/dev/null || true
    find "$staging/node_modules" -name '*.map' -delete 2>/dev/null || true
    find "$staging/node_modules" -name 'AGENTS.md' -delete 2>/dev/null || true
    find "$staging/node_modules" -name 'README.md' -delete 2>/dev/null || true

    # Replace the live node_modules in one swap so a kill-mid-fetch
    # can't leave the resource dir in a partial state.
    rm -rf "$RES_DIR/node_modules"
    mv "$staging/node_modules" "$RES_DIR/node_modules"
    echo -n "$CLAUDE_ACP_VERSION" > "$stamp"
    echo "Installed claude-agent-acp $CLAUDE_ACP_VERSION → $RES_DIR/node_modules/ ($(du -sh "$RES_DIR/node_modules" | cut -f1))"
}

# Map host arch → (codex-acp npm package suffix, Tauri target-triple).
# The Tauri bundler matches `<name>-<target-triple>` exactly when it
# picks which externalBin to embed, so the suffix must be the
# canonical Rust target triple, not the npm platform short-name.
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)  CODEX_PKG="codex-acp-darwin-arm64"; CODEX_TARGET="aarch64-apple-darwin" ;;
  Darwin-x86_64) CODEX_PKG="codex-acp-darwin-x64";   CODEX_TARGET="x86_64-apple-darwin" ;;
  Linux-aarch64) CODEX_PKG="codex-acp-linux-arm64";  CODEX_TARGET="aarch64-unknown-linux-gnu" ;;
  Linux-x86_64)  CODEX_PKG="codex-acp-linux-x64";    CODEX_TARGET="x86_64-unknown-linux-gnu" ;;
  *)
    echo "fetch-acp-binaries: unsupported host $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

install_codex_acp() {
    local out_path="$BIN_DIR/codex-acp-$CODEX_TARGET"
    if [ -x "$out_path" ] && [ -f "$out_path.version" ] \
       && [ "$(cat "$out_path.version")" = "$CODEX_ACP_VERSION" ]; then
        echo "codex-acp $CODEX_ACP_VERSION already present at $out_path — skipping fetch."
        return 0
    fi

    echo "Fetching @zed-industries/$CODEX_PKG@$CODEX_ACP_VERSION..."
    local staging
    staging="$(mktemp -d)"
    # shellcheck disable=SC2064
    trap "rm -rf '$staging'" RETURN
    (
        cd "$staging"
        echo '{"name":"codex-acp-stage","private":true}' > package.json
        # --include=optional: the per-platform binary packages are
        # declared as optionalDependencies of the launcher
        # (@zed-industries/codex-acp), and npm omits optionals by
        # default in some configurations. Force-include so the
        # specific platform binary lands in node_modules/.
        npm install --silent --no-save --include=optional \
            "@zed-industries/$CODEX_PKG@$CODEX_ACP_VERSION"
    )

    local src="$staging/node_modules/@zed-industries/$CODEX_PKG/bin/codex-acp"
    if [ ! -x "$src" ]; then
        echo "fetch-acp-binaries: expected binary not found at $src" >&2
        exit 1
    fi
    install -m 0755 "$src" "$out_path"
    echo -n "$CODEX_ACP_VERSION" > "$out_path.version"
    echo "Installed codex-acp $CODEX_ACP_VERSION → $out_path ($(du -h "$out_path" | cut -f1))"
}

install_claude_acp
install_codex_acp

echo "All ACP assets ready."
