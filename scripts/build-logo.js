/*
 * scripts/build-logo.js — turn the supplied SciWrid artwork into a usable mark.
 *
 * The source PNG shows a transparent-looking checkerboard, but the checkerboard
 * is BAKED IN: every pixel is opaque (alpha 0% transparent across the whole
 * image), so dropping it into a page renders a grey checkered rectangle rather
 * than a floating logo. It is also 1216x879 and 1.66 MB, with 10528 distinct
 * colours for what is a flat four-colour mark -- generation noise, most of it
 * in areas that should be a single flat tone.
 *
 * This keys the checkerboard out, crops to the artwork, and downscales.
 *
 * THE ONE HARD PART is that the white "S" is the same colour as the checker's
 * white squares, so any "light and neutral means background" rule erases it.
 * They are separable by CONTEXT rather than colour: the checkerboard alternates
 * on a 16 px pitch, so every checker-white pixel has a checker-grey pixel a few
 * pixels away, while the "S" sits inside a 159x171 blue tile and has none
 * anywhere near it. Hence the two-pass rule below.
 *
 * The mask is binary at full resolution and softened by the downscale: the
 * artwork is ~748 px and the output is a fraction of that, so box-averaging
 * many source pixels per output pixel produces the antialiasing directly.
 * Trying to estimate partial alpha at full resolution would be guesswork
 * against a background that varies between two tones.
 *
 * Run: node scripts/build-logo.js [source.png]
 */
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = process.argv[2] || resolve(ROOT, 'assets/logo-sciwrid-source.png');
const OUT = resolve(ROOT, 'assets/logo-sciwrid.png');
const SIZE = 256;              // square master; the 32 px header slot is 8x down

const CHECKER_PITCH = 16;      // measured on the source
const NEAR = 26;               // > one checker cell, << the blue tile's 159 px

const png = PNG.sync.read(readFileSync(SRC));
const { width: w, height: h, data: d } = png;
const idx = (x, y) => (y * w + x) * 4;

/* Step 1 — what is unmistakably ARTWORK.
 *
 * Colour alone cannot separate background from foreground here, because the
 * tile's soft glow tints the checkerboard behind it: those pixels are neither
 * neutral (so a neutrality test keeps them) nor artwork (they are checker seen
 * through a halo). Keying on colour left the checker pattern ringing the tile.
 *
 * So only two things are claimed outright -- the dark navy strokes, and the
 * saturated blue of the tile. Everything else is decided by where it sits. */
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const content = new Uint8Array(w * h);
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++) {
    const i = idx(x, y);
    const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
    const ink = luma(r, g, b) < 150;
    const tile = b - r > 100 && b > 140;            // the glow is far weaker
    if (ink || tile) content[y * w + x] = 1;
  }

/* Step 2 — flood the NON-artwork from the border.
 *
 * Everything the flood reaches is outside the mark: the surrounding
 * checkerboard, and the glow-tinted checker with it, since the halo is
 * continuous with the background it sits on. */
const outside = new Uint8Array(w * h);
const stack = [];
for (let x = 0; x < w; x++) { stack.push(x, (h - 1) * w + x); }
for (let y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1); }
while (stack.length) {
  const m = stack.pop();
  if (outside[m] || content[m]) continue;
  outside[m] = 1;
  const x = m % w, y = (m - x) / w;
  if (x > 0) stack.push(m - 1);
  if (x < w - 1) stack.push(m + 1);
  if (y > 0) stack.push(m - w);
  if (y < h - 1) stack.push(m + w);
}

/* Step 3 — the enclosed regions, which are the whole difficulty.
 *
 * Two kinds sit inside the artwork and the flood reaches neither:
 *   - the inside of each rounded square, which is checkerboard and must go
 *   - the "S" inside the blue tile, which is white and must stay
 *
 * They are the same colour family, so the test is whether the region contains
 * any of the checker's GREY band. A square's interior shows both checker
 * tones; the "S" is uniformly white on blue and has no grey in it at all. */
const bg = new Uint8Array(outside);
const seen = new Uint8Array(w * h);
let keptRegions = 0, droppedRegions = 0;
for (let start = 0; start < w * h; start++) {
  if (seen[start] || content[start] || outside[start]) continue;
  const region = [];
  let hasChecker = false;
  const st = [start];
  seen[start] = 1;
  while (st.length) {
    const m = st.pop();
    region.push(m);
    const i = m * 4;
    const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
    if (Math.abs(r - g) < 12 && Math.abs(g - b) < 12 && r > 195 && r < 242) hasChecker = true;
    const x = m % w, y = (m - x) / w;
    const push = (n) => { if (!seen[n] && !content[n]) { seen[n] = 1; st.push(n); } };
    if (x > 0) push(m - 1);
    if (x < w - 1) push(m + 1);
    if (y > 0) push(m - w);
    if (y < h - 1) push(m + w);
  }
  if (hasChecker) { for (const m of region) bg[m] = 1; droppedRegions++; }
  else keptRegions++;
}
console.log(`enclosed regions: ${droppedRegions} checkered (dropped), ${keptRegions} solid (kept)`);

/* Crop to what survives. */
let x0 = w, y0 = h, x1 = -1, y1 = -1;
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++)
    if (!bg[y * w + x]) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
const cw = x1 - x0 + 1, ch = y1 - y0 + 1;

/* Pad to a square around the artwork's centre rather than scaling to a square,
 * so the mark is not stretched by the 1% the crop is off-square. */
const side = Math.max(cw, ch);
const ox = x0 - Math.floor((side - cw) / 2);
const oy = y0 - Math.floor((side - ch) / 2);

/* Box-average downscale. Fully transparent source pixels contribute their
 * coverage but not their colour -- averaging the checker's grey into an edge is
 * exactly the fringing this is meant to avoid. */
const out = new PNG({ width: SIZE, height: SIZE });
const scale = side / SIZE;
for (let oy2 = 0; oy2 < SIZE; oy2++) {
  for (let ox2 = 0; ox2 < SIZE; ox2++) {
    const sx0 = Math.floor(ox + ox2 * scale), sx1 = Math.floor(ox + (ox2 + 1) * scale);
    const sy0 = Math.floor(oy + oy2 * scale), sy1 = Math.floor(oy + (oy2 + 1) * scale);
    let r = 0, g = 0, b = 0, a = 0, n = 0, opaque = 0;
    for (let sy = sy0; sy < Math.max(sy1, sy0 + 1); sy++)
      for (let sx = sx0; sx < Math.max(sx1, sx0 + 1); sx++) {
        n++;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        if (bg[sy * w + sx]) continue;
        const i = idx(sx, sy);
        r += d[i]; g += d[i + 1]; b += d[i + 2]; opaque++;
      }
    a = n ? opaque / n : 0;
    const o = (oy2 * SIZE + ox2) * 4;
    out.data[o]     = opaque ? Math.round(r / opaque) : 0;
    out.data[o + 1] = opaque ? Math.round(g / opaque) : 0;
    out.data[o + 2] = opaque ? Math.round(b / opaque) : 0;
    out.data[o + 3] = Math.round(a * 255);
  }
}

const buf = PNG.sync.write(out, { colorType: 6, deflateLevel: 9 });
writeFileSync(OUT, buf);

const total = SIZE * SIZE;
let transparent = 0, partial = 0;
for (let i = 3; i < out.data.length; i += 4) {
  if (out.data[i] === 0) transparent++;
  else if (out.data[i] < 255) partial++;
}
console.log(`source     ${w}x${h}, ${(readFileSync(SRC).length / 1024 / 1024).toFixed(2)} MB`);
console.log(`artwork    ${cw}x${ch} at (${x0},${y0}) -> square ${side}`);
console.log(`wrote      ${OUT}`);
console.log(`           ${SIZE}x${SIZE}, ${(buf.length / 1024).toFixed(1)} KB`);
console.log(`alpha      ${(100 * transparent / total).toFixed(1)}% transparent, ` +
            `${(100 * partial / total).toFixed(1)}% partial (antialiased edges)`);
