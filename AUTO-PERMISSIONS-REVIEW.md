# Auto-permission classifier — review packet

Status: implementation complete on `feat/auto-permission-classifier`, logic-proven.
Live-runtime proof pending (blocked: disk full). This doc doubles as the PR
description draft. Untracked by design.

## The approach

The closed runtime owns the permission **engine** (its `auto` mode enum value is
reserved but unimplemented: `mode.auto.unimplemented`). The open client owns the
**dialog**. We cannot ship the engine; we can ship the brain in front of the
dialog — which is also how Claude Code's auto mode works (client-side
classification in front of the same allow/ask/deny primitive).

Insertion point: `requestToolPermission()` in `packages/zcode-tui/src/index.ts`
— the single seam where a runtime permission request becomes a human dialog.

```
runtime (closed) ──permission request──▶ requestPermission()
                                           └─ requestToolPermission()
                                                ├─ autoPermissionResponse()   ← NEW
                                                │    verdict → return {decision, reason}
                                                │    (same object the dialog returns)
                                                └─ null → showChoice() (human dialog, unchanged)
```

Every auto-decision prints a TUI notice (`auto-permissions · ALLOW · Bash · …`)
so the transcript shows what happened and why.

## Configuration

- Built-in default policy, conservative: unmatched → **ask** (fail-open toward
  the human).
- `ZCODE_AUTO_PERMISSIONS_CONFIG=<path>` overrides point-wise (allow/softDeny/
  hardDeny rule arrays + `defaults.unmatched: ask|allow|deny`). Malformed or
  missing file silently falls back to built-ins.

## Safety properties (structural, not disciplinary)

- Runs **only where a prompt would have shown** → cannot widen yolo.
- Runtime-side explicit denies never prompt → cannot be overridden.
- `AskUserQuestion` / plan-approval flows untouched (earlier return paths).
- Credential paths (`.env`, `.ssh`, `.aws`, `*.pem`, `id_rsa`, …) are hard-deny,
  even for reads.

## The diff

Base: `376a641` (upstream main, 3.11.2-22). Two conventional commits:

| Commit | Content |
|---|---|
| `c5208e7` feat(tui): auto-approve safe tool prompts via policy classifier | module + wiring + tests (+294) |
| `7d45e4e` feat(tui): classify permission prompts through shared response helper | response helper + readable regex reasons (+47/−11) |

Files: `packages/zcode-tui/src/auto-permissions.ts` (new, ~200 ln),
`packages/zcode-tui/src/index.ts` (+17), `test/auto-permissions.test.ts` (new, ~110 ln).

## Proven (evidence)

| Claim | Evidence | Result |
|---|---|---|
| Classifier semantics (allow prefixes w/ word boundary, deny>allow precedence, credential deny, unmatched=null, config load/fallback) | `bun test test/auto-permissions.test.ts` | 8/8 pass (RED first: module missing) |
| Response mapping (dialog's exact `{decision, reason}` shape; null → dialog path) | same suite, `autoPermissionResponse` cases | pass |
| Type safety | `bun run typecheck` | clean |
| Lint | `bunx biome check` on all 3 touched files | clean (exit 0) |
| No regressions | full suite vs clean-main worktree: 13 fails on my branch, 8 identical on clean main, 3 stream fails pass in isolation on my branch (full-suite load flake) | 0 attributable to diff |
| Policy engine prior art | same rule semantics shipped in the `auto-permissions` hook plugin: 12/12 + end-to-end stdin/stdout protocol runs | proven in plugin repo |

## Live proof (completed 2026-09-08, real client over PTY, isolated HOME)

Method: `scripts/ab-probe.sh` / the interactive runs swap **only** the TUI
bundle (the entire diff) between stock and patched, boot the real client in
build mode, and submit an identical write prompt. Isolated `HOME` + copied
config → runs use the free Flash lane and never touch `~/.zcode`.

| Case | Stock client (BEFORE) | Patched client, auto mode (AFTER) |
|---|---|---|
| Covered write (`Write hello.txt` + scoped allow rule) | `Permission · Write` dialog rendered, unanswered → **no file on disk** | `auto-permissions · ALLOW` notice in transcript, **write executed**, model confirmed the file, no dialog ever rendered |
| Uncovered write (`Write other.txt`) | — (dialog = baseline behavior) | **dialog rendered** — auto defers what the policy does not cover; it is not yolo |
| Mode pill | `◉ build` | `◉ auto` (runtime held in build) |

The live runs caught and fixed one real bug no unit test modeled: the
runtime's build-mode state echo was clearing the overlay before the first
prompt (mode echoes now preserve it; only explicit typed `/mode` exits).

## Remaining before the PR

1. Optional: restore disk headroom and run `bun run sync` + `bun run check` +
   `check:tui` locally (CI on the upstream side runs the linux-locked runtime
   and will exercise these regardless).
2. Update the plugin-side README + `zai-org/feedback` issue text to describe
   the client overlay mode (this repo) alongside the hook plugin.
3. Push: fork under `wesleymatos-bot`, stage the branch, Wesley reviews.

## Review questions (product decisions, not code decisions)

1. Default auto-allow list: currently `git status|log|diff|show|branch`, `ls`,
   `pwd`, `cat`, `head`, `tail`, `wc`, `rg`, `grep`, `find`, `which`, `file`,
   `stat`, plus `Read`/`Glob`/`Grep`/`TodoRead`/`WebSearch`. Right set?
2. Auto-deny currently returns `decision: "deny"` **with** the reason (the
   reason reaches the model per the wire format) — keep, or split into the
   dialog's "deny and tell why" UX?
3. Naming: `auto-permissions` module, `ZCODE_AUTO_PERMISSIONS_CONFIG` env var —
   fit the repo's taste?
