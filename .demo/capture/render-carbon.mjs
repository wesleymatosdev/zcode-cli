// Carbon-style macOS terminal windows: one per capture JSON, no slide text.
// Run: node render-carbon.mjs <name.json> <out.png>
import { readFileSync } from "node:fs";

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
    const safe = text.replace(/ /g, "&nbsp;");
    const style = [fg ? `color:${fg}` : "", bg ? `background:${bg}` : "", bold ? "font-weight:700" : ""]
      .filter(Boolean).join(";");
    return style ? `<span style="${style}">${safe}</span>` : safe;
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

const outPath = process.argv[process.argv.length - 1];
const inNames = process.argv.slice(2, process.argv.length - 1);
if (inNames.length === 0 || !outPath.endsWith(".png")) {
  console.error("usage: node render-carbon.mjs <in1.json> [in2.json ...] <out.png>");
  process.exit(1);
}
const wins = inNames.map((inName) => {
  const json = JSON.parse(readFileSync(new URL(`./${inName}`, import.meta.url), "utf8"));
  const rows = json.lines.map((l) => ansiToHtml(l)).join("\n");
  console.log(`${inName}: rows contains span:`, rows.includes("<span"));
  const title = inName.startsWith("before") ? "zcode — before #136" : "zcode — after #136";
  return `<div class="win">
  <div class="bar">
    <div class="dot" style="background:#ff5f57"></div>
    <div class="dot" style="background:#febc2e"></div>
    <div class="dot" style="background:#28c840"></div>
    <div class="title">${title}</div>
  </div>
  <div class="term">${rows}</div>
</div>`;
}).join("\n");

// Deterministic starfield (seeded LCG -> box-shadow lists, no external images).
function stars(count, seed) {
  let s = seed, shadow = [];
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < count; i++) {
    const x = Math.round(rnd() * 1080), y = Math.round(rnd() * 1350);
    const a = (0.25 + rnd() * 0.65).toFixed(2);
    shadow.push(`${x}px ${y}px rgba(255,255,255,${a})`);
  }
  return shadow.join(",");
}
const starLayer1 = stars(110, 42), starLayer2 = stars(45, 1337);

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  body { margin:0; width:1080px; height:1350px; overflow:hidden; position:relative;
         background:
           radial-gradient(1000px 700px at 12% -8%, rgba(124,58,237,.20), transparent 62%),
           radial-gradient(900px 800px at 108% 112%, rgba(67,56,202,.20), transparent 60%),
           radial-gradient(500px 380px at 88% 8%, rgba(217,119,87,.07), transparent 65%),
           linear-gradient(160deg,#060714 0%,#0a0b1c 48%,#05060f 100%);
         display:flex; flex-direction:column; align-items:center; justify-content:center; gap:56px; }
  .stars1, .stars2 { position:absolute; top:0; left:0; border-radius:50%; pointer-events:none; }
  .stars1 { width:1px; height:1px; background:transparent; box-shadow:${starLayer1}; }
  .stars2 { width:2px; height:2px; background:transparent; box-shadow:${starLayer2}; }
  .win { position:relative; width:760px; border-radius:14px; overflow:hidden; flex:none;
         border:1px solid rgba(148,140,255,.16);
         box-shadow:0 30px 90px rgba(0,0,0,.65), 0 0 60px rgba(124,58,237,.10);
         background:#14151d; }
  .bar { height:40px; display:flex; align-items:center; padding:0 16px;
         background:linear-gradient(#23242c,#1c1d26); border-bottom:1px solid rgba(148,140,255,.10); }
  .dot { width:12px; height:12px; border-radius:50%; margin-right:8px; }
  .title { flex:1; text-align:center; font:12.5px -apple-system,'Helvetica Neue',sans-serif;
           color:#9a9fb5; margin-right:52px; letter-spacing:.2px; }
  .term { padding:16px 20px; background:#14151d;
          font:13px/1.5 'SF Mono',Menlo,monospace; color:#d4d4d4; white-space:pre; }
</style></head><body>
<div class="stars1"></div><div class="stars2"></div>
${wins}
</body></html>`;

const { createRequire } = await import("node:module");
const { chromium } = createRequire("/Users/wesleymatos/projects/personal/swarm/poc/otp-paste/package.json")("playwright");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1350 }, deviceScaleFactor: 2 });
await page.setContent(html);
const spanCount = await page.locator(".term span").count();
const colored = await page.evaluate(() =>
  [...document.querySelectorAll(".term span")].filter((s) => /color:\s*(?!rgb\(212)/.test(s.getAttribute("style") || "")).length);
console.log(`styled spans: ${spanCount}, non-default-colored: ${colored}`);
await page.locator("body").screenshot({ path: outPath });
console.log("rendered", outPath);
await browser.close();