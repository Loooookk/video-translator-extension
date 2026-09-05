/* 生成扩展图标：圆角渐变底 + 三条白色“字幕条” + 高光（纯 Node 实现 PNG 编码） */
import zlib from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = path.join(root, 'icons');
mkdirSync(iconsDir, { recursive: true });

/* ---------- PNG 编码器 (RGBA) ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function encodePNG(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 6;   // RGBA
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter: none
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- 绘制 ---------- */
function insideRounded(x, y, S, r) {
  if (x < 0 || y < 0 || x >= S || y >= S) return false;
  const min = r, max = S - r;
  if (x >= min && x <= max) return true;
  if (y >= min && y <= max) return true;
  const qx = x < min ? min : max;
  const qy = y < min ? min : max;
  return Math.hypot(x - qx, y - qy) <= r;
}

// 胶囊形（圆角条），中心 (cx*S, cy*S)，半宽 hw*S，半高 hh*S
function bar(x, y, S, cx, cy, hw, hh) {
  const X = cx * S, Y = cy * S, HW = hw * S, HH = hh * S;
  const dx = Math.abs(x - X), dy = Math.abs(y - Y);
  if (dx <= HW - HH && dy <= HH) return true;
  if (dx <= HW && dy <= HH && Math.hypot(dx - (HW - HH), dy) <= HH) return true;
  return false;
}

function drawIcon(S) {
  const SS = 3; // 3x3 超采样抗锯齿
  const W = S * SS;
  const acc = new Float32Array(W * W * 3);
  const cx = S / 2;

  for (let sy = 0; sy < W; sy++) {
    for (let sx = 0; sx < W; sx++) {
      const x = (sx + 0.5) / SS, y = (sy + 0.5) / SS;
      let r, g, b;
      if (insideRounded(x, y, S, S * 0.22)) {
        const t = y / S;
        r = 14 + (37 - 14) * t;    // #0ea5e9 → #2563eb 渐变
        g = 165 + (99 - 165) * t;
        b = 233 + (235 - 233) * t;
        // 字幕条
        if (bar(x, y, S, 0.50, 0.60, 0.26, 0.042) ||
            bar(x, y, S, 0.50, 0.71, 0.34, 0.042) ||
            bar(x, y, S, 0.50, 0.82, 0.20, 0.042)) {
          r = 255; g = 255; b = 255;
        } else {
          // 顶部柔光
          const d = Math.hypot(x - cx, y - S * 0.32) / S;
          const glow = Math.max(0, 1 - d / 0.85) * 0.28;
          r += (255 - r) * glow; g += (255 - g) * glow; b += (255 - b) * glow;
          if (y < S * 0.5) { r = Math.min(255, r + 14); g = Math.min(255, g + 14); b = Math.min(255, b + 14); }
        }
      } else { r = 0; g = 0; b = 0; }
      const idx = (sy * W + sx) * 3;
      acc[idx] = r; acc[idx + 1] = g; acc[idx + 2] = b;
    }
  }

  const out = Buffer.alloc(S * S * 4);
  const n2 = SS * SS;
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let r = 0, g = 0, b = 0, inside = 0;
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const xx = x + (dx + 0.5) / SS, yy = y + (dy + 0.5) / SS;
          if (!insideRounded(xx, yy, S, S * 0.22)) continue;
          inside++;
          const i = ((y * SS + dy) * W + (x * SS + dx)) * 3;
          r += acc[i]; g += acc[i + 1]; b += acc[i + 2];
        }
      }
      const o = (y * S + x) * 4;
      out[o + 3] = Math.round(255 * inside / n2);
      if (inside > 0) {
        out[o] = Math.round(r / inside);
        out[o + 1] = Math.round(g / inside);
        out[o + 2] = Math.round(b / inside);
      }
    }
  }
  return out;
}

for (const S of [16, 32, 48, 128]) {
  const file = path.join(iconsDir, 'icon' + S + '.png');
  writeFileSync(file, encodePNG(S, S, drawIcon(S)));
  console.log('✓', path.relative(root, file));
}
console.log('图标生成完成');
