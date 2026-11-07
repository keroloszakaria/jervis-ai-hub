# vendor

`claude-code/index.d.ts` is the plugin API's TypeScript declarations, written by Claude Code 2.1.317. It belongs to Claude Code, not to this project, and is not covered by this repository's MIT license.

It is here only so CI can type-check the plugin (`tsconfig.ci.json`), since Claude Code writes these declarations only when a session loads the mod. When the Claude Code version pinned in `.github/workflows/ci.yml` changes, replace the file with the one Claude Code writes in `.claude-plugin/types/claude-code/index.d.ts`. CI fails when the two versions differ.
