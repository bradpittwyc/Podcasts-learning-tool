#!/usr/bin/env node
/*
 * scripts/make-icon.js
 * ---------------------------------------------------------------------------
 * Generates every icon asset for the "Podcasts Learning Tool" Electron app
 * without any third-party dependency (no sharp / no jimp / no network).
 *
 *   build/icon.ico                  multi-size Windows ICO (PNG compressed)
 *   build/icon.png                  512x512 master PNG
 *   src/renderer/assets/icon.png    identical 512x512 master PNG for the UI
 *
 * How it works
 *   1. A hand written PNG encoder (zlib deflate + own CRC32) writes real PNGs.
 *   2. The artwork is rasterised procedurally at 512x512 with 4x4
 *      supersampling (16 samples per pixel) so every edge is anti-aliased.
 *   3. Each ICO size is produced by an area-average (box filter) downscale of
 *      that single master render, in premultiplied alpha space.
 *   4. A self check re-parses the written ICO/PNG files from disk, validates
 *      every CRC, inflates the image data and prints the sizes it found.
 *
 * Usage:  node scripts/make-icon.js
 * Exit code 0 = everything generated and verified, 1 = verification failed.
 * ---------------------------------------------------------------------------
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ===========================================================================
 * Configuration
 * =========================================================================== */

const ROOT = path.resolve(__dirname, '..');
const OUT_ICO = path.join(ROOT, 'build', 'icon.ico');
const OUT_PNG_MASTER = path.join(ROOT, 'build', 'icon.png');
const OUT_PNG_APP = path.join(ROOT, 'src', 'renderer', 'assets', 'icon.png');

const MASTER_SIZE = 512;                 // master render resolution
const SS = 4;                            // supersampling factor (SS x SS / pixel)
const ICO_SIZES = [256, 128, 64, 48, 32, 16];

/* --- palette -------------------------------------------------------------- */
const GRAD_FROM = [0x1e, 0x6f, 0xd9];    // #1E6FD9  top-left
const GRAD_TO = [0x0b, 0x3e, 0x86];      // #0B3E86  bottom-right
const HIGHLIGHT = [0xff, 0xff, 0xff];    // upper-left sheen
const MOTIF = [0xff, 0xff, 0xff];        // pure white motif
const SHADOW_COLOR = [0x04, 0x1c, 0x40]; // motif drop shadow

/* --- geometry, all values are fractions of the icon edge ------------------ */
const TILE = {
  radius: 0.22,        // squircle-ish corner radius
};

const HEAD = {         // headphone band (arc / ring segment)
  cx: 0.5,
  cy: 0.515,
  r: 0.262,            // centre-line radius
  t: 0.062,            // band thickness
  gap: 0.12,           // angular gap (rad) at each open end
};

const CUP = {          // ear cups (rounded rectangles)
  dx: 0.248,           // x offset from HEAD.cx
  dy: 0.092,           // y offset from HEAD.cy
  hw: 0.055,
  hh: 0.132,
  radius: 0.05,
  alpha: 0.94,         // barely translucent -> subtle depth
};

const BARS = {         // soundwave / equaliser bars
  spacing: 0.0745,
  hw: 0.0195,
  cy: 0.607,           // == HEAD.cy + CUP.dy  (centred between the cups)
  halfHeights: [0.062, 0.1, 0.132, 0.1, 0.062],
};

const HIGHLIGHT_DISC = { cx: 0.28, cy: 0.18, r: 0.85, alpha: 0.17 };
const SHADOW = { dx: 2, dy: 7, blur: 6, alpha: 0.3 };   // pixels @ 512

/* ===========================================================================
 * 1. PNG encoder (signature + IHDR + IDAT + IEND, CRC32 computed here)
 * =========================================================================== */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Encode an 8-bit RGBA image (straight alpha) as a PNG buffer.
 * @param {number} width
 * @param {number} height
 * @param {Buffer} rgba  width*height*4 bytes
 */
function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const dst = y * (stride + 1);
    raw[dst] = 0;                                    // filter type 0 = None
    rgba.copy(raw, dst + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // colour type: truecolour + alpha
  ihdr[10] = 0;   // deflate
  ihdr[11] = 0;   // adaptive filtering
  ihdr[12] = 0;   // no interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ===========================================================================
 * 2. ICO container (ICONDIR + ICONDIRENTRY[] + PNG payloads)
 * =========================================================================== */

/**
 * @param {{size:number, png:Buffer}[]} images
 */
function encodeICO(images) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(0, 0);              // reserved
  dir.writeUInt16LE(1, 2);              // type: 1 = icon
  dir.writeUInt16LE(images.length, 4);  // image count

  const entries = Buffer.alloc(16 * images.length);
  let offset = 6 + 16 * images.length;
  images.forEach((img, i) => {
    const o = i * 16;
    entries[o + 0] = img.size >= 256 ? 0 : img.size;  // 0 means 256
    entries[o + 1] = img.size >= 256 ? 0 : img.size;
    entries[o + 2] = 0;                                // palette colours
    entries[o + 3] = 0;                                // reserved
    entries.writeUInt16LE(1, o + 4);                   // colour planes
    entries.writeUInt16LE(32, o + 6);                  // bits per pixel
    entries.writeUInt32LE(img.png.length, o + 8);      // bytes in resource
    entries.writeUInt32LE(offset, o + 12);             // offset in file
    offset += img.png.length;
  });

  return Buffer.concat([dir, entries, ...images.map((i) => i.png)]);
}

/* ===========================================================================
 * 3. Procedural rasteriser
 * =========================================================================== */

/** Signed test: point inside an axis-aligned rounded rectangle. */
function inRoundRect(x, y, cx, cy, hw, hh, r) {
  const ax = Math.abs(x - cx);
  const ay = Math.abs(y - cy);
  if (ax > hw || ay > hh) return false;
  const qx = ax - (hw - r);
  const qy = ay - (hh - r);
  if (qx <= 0 || qy <= 0) return true;
  return qx * qx + qy * qy <= r * r;
}

/** Point inside a ring segment [ri, ro] spanning angles a0..a1 with round caps. */
function inRingSegment(x, y, cx, cy, ri, ro, a0, a1) {
  const dx = x - cx;
  const dy = y - cy;
  const d = Math.hypot(dx, dy);
  if (d >= ri && d <= ro) {
    let a = Math.atan2(dy, dx);
    if (a < 0) a += 2 * Math.PI;
    if (a >= a0 && a <= a1) return true;
  }
  const rm = (ri + ro) / 2;
  const capR = (ro - ri) / 2;
  const c0x = cx + rm * Math.cos(a0);
  const c0y = cy + rm * Math.sin(a0);
  const c1x = cx + rm * Math.cos(a1);
  const c1y = cy + rm * Math.sin(a1);
  if ((x - c0x) * (x - c0x) + (y - c0y) * (y - c0y) <= capR * capR) return true;
  if ((x - c1x) * (x - c1x) + (y - c1y) * (y - c1y) <= capR * capR) return true;
  return false;
}

/** Diagonal gradient + soft upper-left highlight. */
function tileColor(x, y, size, out) {
  const t = Math.min(1, Math.max(0, (x + y) / (2 * size)));
  let r = GRAD_FROM[0] + (GRAD_TO[0] - GRAD_FROM[0]) * t;
  let g = GRAD_FROM[1] + (GRAD_TO[1] - GRAD_FROM[1]) * t;
  let b = GRAD_FROM[2] + (GRAD_TO[2] - GRAD_FROM[2]) * t;

  const hx = (x / size - HIGHLIGHT_DISC.cx);
  const hy = (y / size - HIGHLIGHT_DISC.cy);
  const d = Math.hypot(hx, hy) / HIGHLIGHT_DISC.r;
  if (d < 1) {
    const w = (1 - d) * (1 - d);
    const a = HIGHLIGHT_DISC.alpha * w;
    r += (HIGHLIGHT[0] - r) * a;
    g += (HIGHLIGHT[1] - g) * a;
    b += (HIGHLIGHT[2] - b) * a;
  }
  out[0] = r / 255;
  out[1] = g / 255;
  out[2] = b / 255;
  return out;
}

/** Edge-clamped 3-pass box blur (a cheap gaussian) for the motif shadow. */
function blurMask(src, size, radius, passes) {
  const inv = 1 / (2 * radius + 1);
  let a = Float32Array.from(src);
  let b = new Float32Array(src.length);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < size; y++) {          // horizontal
      const row = y * size;
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        sum += a[row + Math.min(size - 1, Math.max(0, k))];
      }
      for (let x = 0; x < size; x++) {
        b[row + x] = sum * inv;
        const drop = Math.min(size - 1, Math.max(0, x - radius));
        const add = Math.min(size - 1, Math.max(0, x + radius + 1));
        sum += a[row + add] - a[row + drop];
      }
    }
    for (let x = 0; x < size; x++) {          // vertical
      let sum = 0;
      for (let k = -radius; k <= radius; k++) {
        sum += b[Math.min(size - 1, Math.max(0, k)) * size + x];
      }
      for (let y = 0; y < size; y++) {
        a[y * size + x] = sum * inv;
        const drop = Math.min(size - 1, Math.max(0, y - radius));
        const add = Math.min(size - 1, Math.max(0, y + radius + 1));
        sum += b[add * size + x] - b[drop * size + x];
      }
    }
    b.fill(0);
  }
  return a;
}

/**
 * Render the artwork at `size` x `size` and return straight-alpha RGBA bytes.
 */
function renderMaster(size) {
  const n = size * size;
  const tileCov = new Float32Array(n);   // coverage of the rounded tile
  const bandCov = new Float32Array(n);   // headphone band
  const cupCov = new Float32Array(n);    // ear cups
  const barCov = new Float32Array(n);    // soundwave bars
  const baseR = new Float32Array(n);     // averaged gradient colour
  const baseG = new Float32Array(n);
  const baseB = new Float32Array(n);
  const counts = new Float32Array(n);    // inside-tile samples per pixel

  const S = size;
  const tileR = TILE.radius * S;
  const headCx = HEAD.cx * S;
  const headCy = HEAD.cy * S;
  const headR = HEAD.r * S;
  const headRi = headR - (HEAD.t * S) / 2;
  const headRo = headR + (HEAD.t * S) / 2;
  const a0 = Math.PI + HEAD.gap;
  const a1 = 2 * Math.PI - HEAD.gap;
  const cupCx = CUP.dx * S;
  const cupCy = CUP.dy * S;
  const cupHw = CUP.hw * S;
  const cupHh = CUP.hh * S;
  const cupR = CUP.radius * S;
  const bars = BARS.halfHeights.map((hh, i) => ({
    cx: S / 2 + (i - (BARS.halfHeights.length - 1) / 2) * BARS.spacing * S,
    cy: BARS.cy * S,
    hw: BARS.hw * S,
    hh: hh * S,
  }));

  const sub = 1 / SS;
  const rgb = [0, 0, 0];

  for (let py = 0; py < S; py++) {
    for (let px = 0; px < S; px++) {
      const idx = py * S + px;
      let tCount = 0, bCount = 0, cCount = 0, sCount = 0;
      let ar = 0, ag = 0, ab = 0;

      for (let sy = 0; sy < SS; sy++) {
        const y = py + (sy + 0.5) * sub;
        for (let sx = 0; sx < SS; sx++) {
          const x = px + (sx + 0.5) * sub;

          // --- tile ---------------------------------------------------------
          if (!inRoundRect(x, y, S / 2, S / 2, S / 2, S / 2, tileR)) continue;
          tCount++;
          tileColor(x, y, S, rgb);
          ar += rgb[0]; ag += rgb[1]; ab += rgb[2];

          // --- motif (mutually exclusive so coverages never double count) ----
          if (inRingSegment(x, y, headCx, headCy, headRi, headRo, a0, a1)) {
            bCount++;
          } else if (
            inRoundRect(x, y, headCx - cupCx, headCy + cupCy, cupHw, cupHh, cupR) ||
            inRoundRect(x, y, headCx + cupCx, headCy + cupCy, cupHw, cupHh, cupR)
          ) {
            cCount++;
          } else {
            for (let i = 0; i < bars.length; i++) {
              const b = bars[i];
              if (inRoundRect(x, y, b.cx, b.cy, b.hw, b.hh, b.hw)) { sCount++; break; }
            }
          }
        }
      }

      const inv = 1 / (SS * SS);
      tileCov[idx] = tCount * inv;
      bandCov[idx] = bCount * inv;
      cupCov[idx] = cCount * inv;
      barCov[idx] = sCount * inv;
      counts[idx] = tCount;
      if (tCount > 0) {
        baseR[idx] = ar / tCount;
        baseG[idx] = ag / tCount;
        baseB[idx] = ab / tCount;
      }
    }
  }

  // --- motif mask, blurred into a soft drop shadow -------------------------
  const motifMask = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    motifMask[i] = Math.min(1, bandCov[i] + cupCov[i] + barCov[i]);
  }
  const shadow = blurMask(motifMask, S, SHADOW.blur, 3);

  // --- composite (premultiplied) then un-premultiply -----------------------
  const out = Buffer.alloc(n * 4);
  const sdx = SHADOW.dx;
  const sdy = SHADOW.dy;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const idx = y * S + x;
      const tc = tileCov[idx];
      let r = 0, g = 0, b = 0, a = 0;

      if (tc > 0) {                       // gradient tile
        r = baseR[idx] * tc;
        g = baseG[idx] * tc;
        b = baseB[idx] * tc;
        a = tc;
      }
      if (a > 0) {                        // motif shadow, clipped to the tile
        const sx = Math.min(S - 1, Math.max(0, x - sdx));
        const sy = Math.min(S - 1, Math.max(0, y - sdy));
        const sa = shadow[sy * S + sx] * SHADOW.alpha * tc;
        if (sa > 0) {                     // premultiplied source-over
          const inv2 = 1 - sa;
          r = r * inv2 + sa * (SHADOW_COLOR[0] / 255);
          g = g * inv2 + sa * (SHADOW_COLOR[1] / 255);
          b = b * inv2 + sa * (SHADOW_COLOR[2] / 255);
          a = a * inv2 + sa;
        }
      }
      const ma = Math.min(1, bandCov[idx] + cupCov[idx] * CUP.alpha + barCov[idx]);
      if (ma > 0) {                       // white motif on top
        const inv2 = 1 - ma;
        r = r * inv2 + ma * (MOTIF[0] / 255);
        g = g * inv2 + ma * (MOTIF[1] / 255);
        b = b * inv2 + ma * (MOTIF[2] / 255);
        a = a * inv2 + ma;
      }

      const o = idx * 4;
      if (a <= 0.0001) {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
      } else {
        out[o] = Math.round(Math.min(1, r / a) * 255);
        out[o + 1] = Math.round(Math.min(1, g / a) * 255);
        out[o + 2] = Math.round(Math.min(1, b / a) * 255);
        out[o + 3] = Math.round(Math.min(1, a) * 255);
      }
    }
  }
  return out;
}

/* ===========================================================================
 * 4. Area-average (box filter) downscale in premultiplied alpha space
 * =========================================================================== */

/** sRGB transfer functions - averaging in linear light keeps thin white
 *  features (the soundwave bars) alive in the 16/32 px frames. */
function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

function toPremultiplied(rgba, w, h) {
  const out = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = rgba[i * 4 + 3] / 255;
    out[i * 4] = srgbToLinear(rgba[i * 4] / 255) * a;
    out[i * 4 + 1] = srgbToLinear(rgba[i * 4 + 1] / 255) * a;
    out[i * 4 + 2] = srgbToLinear(rgba[i * 4 + 2] / 255) * a;
    out[i * 4 + 3] = a;
  }
  return out;
}

function areaResample(src, sw, sh, dw, dh) {
  const tmp = new Float32Array(dw * sh * 4);
  const xs = sw / dw;
  for (let y = 0; y < sh; y++) {
    for (let dx = 0; dx < dw; dx++) {
      const s0 = dx * xs;
      const s1 = s0 + xs;
      const i0 = Math.floor(s0);
      const i1 = Math.min(sw - 1, Math.ceil(s1) - 1);
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let i = i0; i <= i1; i++) {
        const w = Math.min(s1, i + 1) - Math.max(s0, i);
        if (w <= 0) continue;
        const o = (y * sw + i) * 4;
        r += src[o] * w; g += src[o + 1] * w; b += src[o + 2] * w; a += src[o + 3] * w;
        wsum += w;
      }
      const d = (y * dw + dx) * 4;
      tmp[d] = r / wsum; tmp[d + 1] = g / wsum; tmp[d + 2] = b / wsum; tmp[d + 3] = a / wsum;
    }
  }

  const out = new Float32Array(dw * dh * 4);
  const ys = sh / dh;
  for (let dy = 0; dy < dh; dy++) {
    const s0 = dy * ys;
    const s1 = s0 + ys;
    const j0 = Math.floor(s0);
    const j1 = Math.min(sh - 1, Math.ceil(s1) - 1);
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let j = j0; j <= j1; j++) {
        const w = Math.min(s1, j + 1) - Math.max(s0, j);
        if (w <= 0) continue;
        const o = (j * dw + x) * 4;
        r += tmp[o] * w; g += tmp[o + 1] * w; b += tmp[o + 2] * w; a += tmp[o + 3] * w;
        wsum += w;
      }
      const d = (dy * dw + x) * 4;
      out[d] = r / wsum; out[d + 1] = g / wsum; out[d + 2] = b / wsum; out[d + 3] = a / wsum;
    }
  }
  return out;
}

function premultipliedToRGBA(premul) {
  const n = premul.length / 4;
  const out = Buffer.alloc(premul.length);
  for (let i = 0; i < n; i++) {
    const a = Math.min(1, Math.max(0, premul[i * 4 + 3]));
    if (a <= 0.0001) continue;
    out[i * 4] = Math.round(Math.min(1, linearToSrgb(premul[i * 4] / a)) * 255);
    out[i * 4 + 1] = Math.round(Math.min(1, linearToSrgb(premul[i * 4 + 1] / a)) * 255);
    out[i * 4 + 2] = Math.round(Math.min(1, linearToSrgb(premul[i * 4 + 2] / a)) * 255);
    out[i * 4 + 3] = Math.round(a * 255);
  }
  return out;
}

/* ===========================================================================
 * 5. Self check: re-parse what we just wrote
 * =========================================================================== */

function verifyPNG(buf, label, expectedSize) {
  const problems = [];
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) problems.push(`${label}: bad PNG signature`);

  let off = 8;
  let ihdr = null;
  const idat = [];
  let sawIEND = false;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const stored = buf.readUInt32BE(off + 8 + len);
    const actual = crc32(buf.subarray(off + 4, off + 8 + len));
    if (stored !== actual) problems.push(`${label}: CRC mismatch in ${type} chunk`);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      sawIEND = true;
    }
    off += 12 + len;
  }

  if (!ihdr) {
    problems.push(`${label}: no IHDR`);
    return { problems, size: 0 };
  }
  if (!sawIEND) problems.push(`${label}: no IEND`);
  if (ihdr.depth !== 8 || ihdr.colorType !== 6) problems.push(`${label}: expected 8-bit RGBA`);
  if (ihdr.interlace !== 0) problems.push(`${label}: unexpected interlace`);
  if (expectedSize && (ihdr.width !== expectedSize || ihdr.height !== expectedSize)) {
    problems.push(`${label}: expected ${expectedSize}x${expectedSize}, got ${ihdr.width}x${ihdr.height}`);
  }

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = ihdr.width * 4 + 1;
  let pixels = null;
  if (raw.length !== stride * ihdr.height) {
    problems.push(`${label}: inflated ${raw.length} bytes, expected ${stride * ihdr.height}`);
  } else {
    pixels = Buffer.alloc(ihdr.width * ihdr.height * 4);
    for (let y = 0; y < ihdr.height; y++) {
      if (raw[y * stride] !== 0) {
        problems.push(`${label}: scanline ${y} uses filter ${raw[y * stride]}, expected 0`);
        break;
      }
      raw.copy(pixels, y * ihdr.width * 4, y * stride + 1, y * stride + 1 + ihdr.width * 4);
    }
  }
  return {
    problems,
    size: ihdr.width,
    bytes: raw.length,
    width: ihdr.width,
    height: ihdr.height,
    pixels,
  };
}

function verifyICO(buf) {
  const problems = [];
  const found = [];
  if (buf.length < 6) return { problems: ['icon.ico: truncated header'], found };

  const reserved = buf.readUInt16LE(0);
  const type = buf.readUInt16LE(2);
  const count = buf.readUInt16LE(4);
  if (reserved !== 0) problems.push('icon.ico: reserved field != 0');
  if (type !== 1) problems.push('icon.ico: type != 1');
  if (count !== ICO_SIZES.length) problems.push(`icon.ico: count ${count} != ${ICO_SIZES.length}`);

  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    if (o + 16 > buf.length) {
      problems.push(`icon.ico: entry ${i} out of range`);
      break;
    }
    const w = buf[o] === 0 ? 256 : buf[o];
    const h = buf[o + 1] === 0 ? 256 : buf[o + 1];
    const planes = buf.readUInt16LE(o + 4);
    const bits = buf.readUInt16LE(o + 6);
    const bytes = buf.readUInt32LE(o + 8);
    const offset = buf.readUInt32LE(o + 12);

    if (w !== h) problems.push(`icon.ico: entry ${i} is not square (${w}x${h})`);
    if (planes !== 1) problems.push(`icon.ico: entry ${i} planes != 1`);
    if (bits !== 32) problems.push(`icon.ico: entry ${i} bitCount != 32`);
    if (offset + bytes > buf.length) {
      problems.push(`icon.ico: entry ${i} payload out of range`);
      continue;
    }
    const payload = buf.subarray(offset, offset + bytes);
    const res = verifyPNG(payload, `icon.ico[${w}x${h}]`, w);
    problems.push(...res.problems);
    found.push({ declared: w, png: res.size, bytes });
  }

  const declared = ICO_SIZES.slice().sort((a, b) => b - a);
  const actual = found.map((f) => f.declared).sort((a, b) => b - a);
  if (JSON.stringify(declared) !== JSON.stringify(actual)) {
    problems.push(`icon.ico: sizes ${actual.join(',')} != expected ${declared.join(',')}`);
  }
  return { problems, found };
}

/* ===========================================================================
 * 6. Main
 * =========================================================================== */

function main() {
  const t0 = Date.now();
  fs.mkdirSync(path.dirname(OUT_ICO), { recursive: true });
  fs.mkdirSync(path.dirname(OUT_PNG_APP), { recursive: true });

  console.log(`[make-icon] rasterising ${MASTER_SIZE}x${MASTER_SIZE} master (${SS}x${SS} supersampling)...`);
  const masterRGBA = renderMaster(MASTER_SIZE);
  const masterPNG = encodePNG(MASTER_SIZE, MASTER_SIZE, masterRGBA);
  const premul = toPremultiplied(masterRGBA, MASTER_SIZE, MASTER_SIZE);

  fs.writeFileSync(OUT_PNG_MASTER, masterPNG);
  fs.writeFileSync(OUT_PNG_APP, masterPNG);
  console.log(`[make-icon] wrote ${path.relative(ROOT, OUT_PNG_MASTER)} (${masterPNG.length} bytes)`);
  console.log(`[make-icon] wrote ${path.relative(ROOT, OUT_PNG_APP)} (${masterPNG.length} bytes)`);

  const images = ICO_SIZES.map((size) => {
    const scaled = size === MASTER_SIZE
      ? premul
      : areaResample(premul, MASTER_SIZE, MASTER_SIZE, size, size);
    const png = encodePNG(size, size, premultipliedToRGBA(scaled));
    return { size, png };
  });
  const ico = encodeICO(images);
  fs.writeFileSync(OUT_ICO, ico);
  console.log(`[make-icon] wrote ${path.relative(ROOT, OUT_ICO)} (${ico.length} bytes, ${images.length} images)`);

  /* ------------------------- verification pass --------------------------- */
  console.log('[make-icon] verifying written files...');
  const problems = [];

  const icoDisk = fs.readFileSync(OUT_ICO);
  const icoCheck = verifyICO(icoDisk);
  problems.push(...icoCheck.problems);
  console.log(`  icon.ico       : ${icoCheck.found.length} PNG images`);
  for (const f of icoCheck.found) {
    const ok = f.declared === f.png ? 'ok' : 'MISMATCH';
    console.log(`    - declared ${String(f.declared).padStart(3)}x${String(f.declared).padEnd(3)} -> PNG ${String(f.png).padStart(3)}x${String(f.png).padEnd(3)}  ${String(f.bytes).padStart(6)} bytes  [${ok}]`);
  }
  console.log(`  sizes found    : ${icoCheck.found.map((f) => `${f.declared}x${f.declared}`).join(', ')}`);

  const masterDisk = fs.readFileSync(OUT_PNG_MASTER);
  const masterCheck = verifyPNG(masterDisk, 'build/icon.png', MASTER_SIZE);
  problems.push(...masterCheck.problems);
  console.log(`  build/icon.png : ${masterCheck.width}x${masterCheck.height} RGBA8, inflated ${masterCheck.bytes} bytes`);

  const appDisk = fs.readFileSync(OUT_PNG_APP);
  const appCheck = verifyPNG(appDisk, 'src/renderer/assets/icon.png', MASTER_SIZE);
  problems.push(...appCheck.problems);
  console.log(`  assets/icon.png: ${appCheck.width}x${appCheck.height} RGBA8, inflated ${appCheck.bytes} bytes`);
  if (!masterDisk.equals(appDisk)) problems.push('build/icon.png and src/renderer/assets/icon.png differ');

  // sanity check the decoded artwork: opaque tile, clear corners, white motif
  const px = masterCheck.pixels;
  const alphaAt = (x, y) => px[(y * MASTER_SIZE + x) * 4 + 3];
  const rgbAt = (x, y) => [
    px[(y * MASTER_SIZE + x) * 4],
    px[(y * MASTER_SIZE + x) * 4 + 1],
    px[(y * MASTER_SIZE + x) * 4 + 2],
  ];
  if (!px) {
    problems.push('artwork: master PNG could not be decoded');
  } else {
    if (alphaAt(2, 2) !== 0) problems.push('artwork: top-left corner is not transparent');
    if (alphaAt(MASTER_SIZE - 3, MASTER_SIZE - 3) !== 0) problems.push('artwork: bottom-right corner is not transparent');
    if (alphaAt(MASTER_SIZE / 2, 6) !== 255) problems.push('artwork: tile centre-top is not opaque');
    const top = rgbAt(Math.round(0.16 * MASTER_SIZE), Math.round(0.1 * MASTER_SIZE));
    const bot = rgbAt(MASTER_SIZE - 40, MASTER_SIZE - 40);
    if (!(top[2] > 140 && top[0] < 110)) problems.push(`artwork: upper-left tile colour unexpected (${top.join(',')})`);
    if (!(bot[2] < 170 && bot[2] > 60)) problems.push(`artwork: lower-right tile colour unexpected (${bot.join(',')})`);
    const bandTop = rgbAt(MASTER_SIZE / 2, Math.round(0.235 * MASTER_SIZE));
    if (!(bandTop[0] > 200 && bandTop[1] > 200 && bandTop[2] > 200)) {
      problems.push(`artwork: headphone band is not white (${bandTop.join(',')})`);
    }
    const cupMid = rgbAt(Math.round(0.25 * MASTER_SIZE), Math.round(0.6 * MASTER_SIZE));
    if (!(cupMid[0] > 200 && cupMid[1] > 200 && cupMid[2] > 200)) {
      problems.push(`artwork: ear cup is not white (${cupMid.join(',')})`);
    }
    const centreBar = rgbAt(MASTER_SIZE / 2, Math.round(0.607 * MASTER_SIZE));
    if (!(centreBar[0] > 200 && centreBar[1] > 200 && centreBar[2] > 200)) {
      problems.push(`artwork: centre soundwave bar is not white (${centreBar.join(',')})`);
    }
  }

  if (problems.length) {
    console.error('[make-icon] VERIFICATION FAILED:');
    for (const p of problems) console.error('  ! ' + p);
    process.exit(1);
  }
  console.log(`[make-icon] OK - all assets generated and verified in ${Date.now() - t0} ms`);
}

main();
