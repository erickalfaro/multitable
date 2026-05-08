// Pin of the codex-cli version that generated the surrounding TS bindings.
// Regenerate via:
//   codex app-server generate-ts --out packages/daemon/src/agent/providers/codex-protocol/
// Then bump this constant. The generator overwrites index.ts and individual
// type files, but leaves _-prefixed siblings untouched, so this file survives
// regeneration and serves as the version anchor for upgrade audits.
export const CODEX_CLI_VERSION = '0.128.0';
