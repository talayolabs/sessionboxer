/**
 * The Provider CLIs the macOS base gets as release archives (the npm ones install in `macos.ts`):
 * OpenCode (ADR-0076), fx (ADR-0077) and Mistral Vibe (ADR-0085), each pinned with the Sandbox
 * image under `~/.local/share/<tool>/<version>` and linked into `~/.local/bin`. Lines for
 * `provisionScript()`, which defines `say`, `fail`, `NODE_ARCH` (x64/arm64) and `FX_ARCH`
 * (x86_64/aarch64) before them.
 */

/** OpenCode, pinned with the Sandbox image (ADR-0076): the binary of its npm platform package. */
const OPENCODE_VERSION = "1.18.32";
/** fx (ADR-0077): the release archive for macOS; same pin as the Sandbox image. */
const FX_VERSION = "v0.0.11";
/** Mistral Vibe (ADR-0085): the `vibe-acp` release archive for macOS, checksummed; same pin as the Sandbox image. */
const VIBE_VERSION = "2.25.8";
const VIBE_SHA256: Record<"aarch64" | "x86_64", string> = {
  aarch64: "357305c3c728883eec26232763f4e414fcec51aafdcc75d04e2f78755f7917ce",
  x86_64: "5f1731d76d8c3f8031c2cfd7990cd79c9c4b234d2595e78b10b7b91b469fd6dc",
};

export function archiveToolLines(): string[] {
  return [
    // OpenCode (`opencode acp`), kept apart from ~/.local/share/opencode, which is OpenCode's own data directory.
    `OPENCODE_DIR="$HOME/.local/share/opencode-cli/versions/${OPENCODE_VERSION}"`,
    `if [ -x "$OPENCODE_DIR/opencode" ]; then`,
    `  say "opencode ${OPENCODE_VERSION} present"`,
    "else",
    `  say "installing OpenCode ${OPENCODE_VERSION} ($NODE_ARCH)"`,
    `  rm -rf "$OPENCODE_DIR.tmp" && mkdir -p "$OPENCODE_DIR.tmp"`,
    `  curl -fsSL --retry 5 --retry-all-errors "https://registry.npmjs.org/opencode-darwin-$NODE_ARCH/-/opencode-darwin-$NODE_ARCH-${OPENCODE_VERSION}.tgz" | tar -xzf - -C "$OPENCODE_DIR.tmp" --strip-components=2 package/bin/opencode || fail "downloading OpenCode"`,
    `  [ -x "$OPENCODE_DIR.tmp/opencode" ] || fail "the OpenCode package has no opencode binary"`,
    `  rm -rf "$OPENCODE_DIR" && mv "$OPENCODE_DIR.tmp" "$OPENCODE_DIR"`,
    "fi",
    `ln -sfn "$OPENCODE_DIR/opencode" "$HOME/.local/bin/opencode"`,
    `say "opencode $(OPENCODE_DISABLE_AUTOUPDATE=1 "$HOME/.local/bin/opencode" --version 2>/dev/null | head -1)"`,
    // fx (ADR-0077): the release archive (fx, LICENSE, THIRD_PARTY_NOTICES.md) for the Mac's architecture.
    `FX_DIR="$HOME/.local/share/fx/${FX_VERSION}"`,
    `if [ -x "$FX_DIR/fx" ]; then`,
    `  say "fx ${FX_VERSION} present"`,
    "else",
    `  say "installing fx ${FX_VERSION} ($FX_ARCH)"`,
    `  rm -rf "$FX_DIR.tmp" && mkdir -p "$FX_DIR.tmp"`,
    `  curl -fsSL --retry 5 --retry-all-errors "https://releases.fx.sh/${FX_VERSION}/fx-macos-$FX_ARCH.tar.gz" | tar -xzf - -C "$FX_DIR.tmp" || fail "downloading fx"`,
    `  [ -x "$FX_DIR.tmp/fx" ] || fail "the fx archive has no fx binary"`,
    `  rm -rf "$FX_DIR" && mv "$FX_DIR.tmp" "$FX_DIR"`,
    "fi",
    `ln -sfn "$FX_DIR/fx" "$HOME/.local/bin/fx"`,
    `say "fx $("$HOME/.local/bin/fx" --version 2>/dev/null | head -1)"`,
    // Mistral Vibe (ADR-0085): the `vibe-acp` archive (the binary and its _internal/ runtime) for the Mac's architecture.
    `VIBE_DIR="$HOME/.local/share/vibe/${VIBE_VERSION}"`,
    `case "$FX_ARCH" in arm64) VIBE_ARCH=aarch64; VIBE_SHA=${VIBE_SHA256.aarch64} ;; *) VIBE_ARCH=x86_64; VIBE_SHA=${VIBE_SHA256.x86_64} ;; esac`,
    `if [ -x "$VIBE_DIR/vibe-acp" ]; then`,
    `  say "Mistral Vibe ${VIBE_VERSION} present"`,
    "else",
    `  say "installing Mistral Vibe ${VIBE_VERSION} ($VIBE_ARCH)"`,
    `  rm -rf "$VIBE_DIR.tmp" && mkdir -p "$VIBE_DIR.tmp"`,
    `  curl -fsSL --retry 5 --retry-all-errors -o "$VIBE_DIR.tmp/vibe-acp.tar.gz" "https://github.com/mistralai/mistral-vibe/releases/download/v${VIBE_VERSION}/vibe-acp-darwin-$VIBE_ARCH-${VIBE_VERSION}.tar.gz" || fail "downloading Mistral Vibe"`,
    `  [ "$(shasum -a 256 "$VIBE_DIR.tmp/vibe-acp.tar.gz" | awk '{ print $1 }')" = "$VIBE_SHA" ] || fail "the Mistral Vibe archive does not match its checksum"`,
    `  tar -xzf "$VIBE_DIR.tmp/vibe-acp.tar.gz" -C "$VIBE_DIR.tmp" && rm -f "$VIBE_DIR.tmp/vibe-acp.tar.gz" || fail "unpacking Mistral Vibe"`,
    `  [ -x "$VIBE_DIR.tmp/vibe-acp" ] || fail "the Mistral Vibe archive has no vibe-acp binary"`,
    `  rm -rf "$VIBE_DIR" && mv "$VIBE_DIR.tmp" "$VIBE_DIR"`,
    "fi",
    `ln -sfn "$VIBE_DIR/vibe-acp" "$HOME/.local/bin/vibe-acp"`,
    `say "vibe-acp $(VIBE_ENABLE_AUTO_UPDATE=false "$HOME/.local/bin/vibe-acp" --version 2>/dev/null | head -1)"`,
  ];
}
