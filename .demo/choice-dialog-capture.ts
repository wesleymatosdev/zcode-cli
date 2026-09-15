#!/usr/bin/env bun
// Renders the REAL choice-dialog (production code of whichever checkout runs it)
// exactly as the tool-permission flow shows it (showChoice, numberShortcuts: true,
// with a tool-input preview pane). No network, no API, no auth — pure renderer.
// Usage: bun .demo/choice-dialog-capture.ts <out.json>
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Box, Container, Text, type Component, type TUI } from "@earendil-works/pi-tui";

import { choose } from "../packages/zcode-tui/src/choice-dialog.ts";
import { createTheme } from "../packages/zcode-tui/src/theme.ts";

const outPath = process.argv[2];
if (!outPath) {
  console.error("usage: bun .demo/choice-dialog-capture.ts <out.json>");
  process.exit(1);
}

const COLS = Number(process.env.COLS || 110);
const theme = createTheme(true);
const host = new Container();
const focusState: { current: Component | null } = { current: null };
let overlay: { component: Component } | undefined;
const ui = {
  mode: "fullscreen",
  terminal: { columns: COLS, rows: 30 },
  requestRender() {},
  setFocus(component: Component | null) {
    focusState.current = component;
    if (component && "focused" in component) {
      (component as Component & { focused: boolean }).focused = true;
    }
  },
  showOverlay(component: Component) {
    overlay = { component };
    return {
      focus() {},
      hide() {},
      isFocused: () => true,
      isHidden: () => false,
      setHidden() {},
      unfocus() {}
    };
  }
} as unknown as TUI;

// Mirrors TuiSession.showChoice for tool permissions (packages/zcode-tui/src/index.ts).
const preview = new Box(1, 0, theme.toolPendingBackground);
preview.addChild(new Text(theme.bold("rm -rf node_modules/.cache"), 0, 0));
preview.addChild(new Text(theme.muted("Risk: high · destructive"), 0, 0));

const pending = choose(ui, host, theme, {
  title: "Permission · bash",
  prompt: "bash requests permission to continue.",
  items: [
    { value: "allow_once", label: "Allow once", description: "Approve only this request" },
    { value: "allow_project", label: "Always allow in this project", description: "Allow matching bash requests" },
    { value: "deny", label: "Deny", description: "Reject this request" }
  ],
  numberShortcuts: true,
  content: preview,
  contentLabel: "Input"
});

if (!overlay) throw new Error("dialog did not mount an overlay");
const lines = overlay.component.render(COLS);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify({ cols: COLS, lines }, null, 2));
console.log(`captured ${lines.length} lines -> ${outPath}`);
process.exit(0);