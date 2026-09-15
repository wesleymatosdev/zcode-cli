// Renders .demo/capture/{before,after}.json to PNGs via headless chromium.
// Offline: computes the xterm-256 palette in JS, parses the SGR the dialog emitted.
// Run: NODE_PATH=~/projects/personal/swarm/poc/otp-paste/node_modules node render-png.mjs
import { readFileSync } from "node:fs";

// xterm-256 palette: 16 base + 6x6x6 cube + grayscale ramp
const C16 = ["#000000","#cd3131","#0dbc79","#e5e510","#2472c8","#bc3fbc","#29b8db","#e5e5e5","#585858","#cd3133","#0dbc79","#e5e510","#2472c8","#bc3fbc","#29b8db","#ffffff"];
function color256(n) {
  if (n < 16) return C16[n];
  if (n < 232) {
    const i = n - 16, v = (x) => (x ? 55 + x * 40 : 0);
    return `rgb(${v(Math.floor(i / 36))},${v(Math.floor((i % 36) / 6))},${v(i % 6)})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g},${g},${g})`;
}

function ansiToHtml(line) {
  let out = "", fg = null, bg = null, bold = false, last = 0;
  const esc = /\x1b\[([0-9;]*)m/g;
  let m;
  const span = (text) => {
    if (!text) return "";
    const style = [
      fg ? `color:${fg}` : "",
      bg ? `background:${bg}` : "",
      bold ? "font-weight:700" : ""
    ].filter(Boolean).join(";");
    return style ? `<span style="${style}">${text}</span>` : text;
  };
  while ((m = esc.exec(line))) {
    out += span(line.slice(last, m.index));
    const params = m[1] === "" ? [0] : m[1].split(";").map(Number);
    let k = 0;
    while (k < params.length) {
      const p = params[k];
      if (p === 0) { fg = bg = null; bold = false; }
      else if (p === 1) bold = true;
      else if (p === 22) bold = false;
      else if (p === 39) fg = null;
      else if (p === 49) bg = null;
      else if ((p === 38 || p === 48) && params[k + 1] === 5) {
        const c = color256(params[k + 2]);
        if (p === 38) fg = c; else bg = c;
        k += 2;
      } else if (p >= 30 && p <= 37) fg = C16[p - 30];
      else if (p >= 90 && p <= 97) fg = C16[p - 90 + 8];
      else if (p >= 40 && p <= 47) bg = C16[p - 40];
      else if (p >= 100 && p <= 107) bg = C16[p - 100 + 8];
      k++;
    }
    last = esc.lastIndex;
  }
  return out + span(line.slice(last));
}

function pageHtml(json) {
  const rows = json.lines
    .map((l) => ansiToHtml(l).replace(/ /g, "&nbsp;") || "")
    .join("\n");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; background: #16161e; }
    .term { display: inline-block; padding: 18px 22px; background: #16161e;
            font: 13px/1.5 Menlo, monospace; color: #d4d4d4; white-space: pre; }
  </style></head><body><div class="term">${rows}</div></body></html>`;
}

const { createRequire } = await import("node:module");
const { chromium } = createRequire("/Users/wesleymatos/projects/personal/swarm/poc/otp-paste/package.json")("playwright");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 980, height: 460 }, deviceScaleFactor: 2 });

const nameIn = process.argv[2] || "before";
const nameOut = process.argv[3] || nameIn;
const json = JSON.parse(readFileSync(new URL(`./${nameIn}.json`, import.meta.url), "utf8"));
await page.setContent(pageHtml(json));
await page.locator(".term").screenshot({ path: new URL(`./${nameOut}.png`, import.meta.url).pathname });
console.log(`rendered ${nameOut}.png`);
await browser.close();