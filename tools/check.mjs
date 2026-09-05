/* 扩展静态校验：manifest JSON、JS 语法、引用文件完整性、PNG 签名 */
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;
const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => { console.error('  ✗ ' + m); failed = true; };

console.log('[1/4] manifest.json');
const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
ok('JSON 有效 · MV' + manifest.manifest_version + ' · v' + manifest.version);
const jsFiles = [
  'background.js',
  'content/content.js',
  'popup/popup.js',
  'offscreen/offscreen.js',
  'offscreen/pcm-worklet.js',
  'offscreen/audio-utils.js',
  'offscreen/whisper-language.js',
  'lib/translation.js',
  'tools/asr-smoke.mjs',
];
const refs = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  ...Object.values(manifest.icons),
  ...manifest.content_scripts.flatMap(c => c.js),
  'offscreen/offscreen.html',
  'offscreen/pcm-worklet.js',
  'vendor/transformers.min.js',
  'vendor/ort.bundle.min.mjs',
  'vendor/ort-wasm-simd-threaded.jsep.wasm',
];
console.log('[2/4] 引用文件');
for (const f of refs) {
  if (existsSync(path.join(root, f))) ok(f);
  else bad('缺失: ' + f);
}
console.log('[3/4] JS 语法');
for (const f of jsFiles) {
  try {
    execFileSync('node', ['--check', path.join(root, f)], { stdio: 'pipe' });
    ok(f);
  } catch (e) {
    bad(f + ' 语法错误');
    console.error(String(e.stderr || e).slice(0, 800));
  }
}
console.log('[4/4] PNG 图标签名');
for (const f of Object.values(manifest.icons)) {
  const b = readFileSync(path.join(root, f));
  const sig = b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  if (sig) ok(f);
  else bad(f + ' 不是有效 PNG');
}

if (failed) { console.error('\n❌ 校验未通过'); process.exit(1); }
console.log('\n✅ 全部校验通过');
