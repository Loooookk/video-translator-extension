/* 将 transformers.js (含 Whisper 模型运行时) 打包进扩展 vendor 目录 */
import { cpSync, mkdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = path.join(root, 'vendor');
mkdirSync(vendorDir, { recursive: true });

const files = [
  ['node_modules/@huggingface/transformers/dist/transformers.min.js', 'transformers.min.js'],
  // ONNX Runtime WASM 运行时：主线程胶水 + wasm 二进制 + 多线程 worker
  ['node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.mjs'],
  ['node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.wasm'],
  ['node_modules/onnxruntime-web/dist/ort.bundle.min.mjs', 'ort.bundle.min.mjs'],
];

for (const [src, dst] of files) {
  const from = path.join(root, src);
  if (!existsSync(from)) {
    console.error('缺少文件：' + from);
    process.exit(1);
  }
  cpSync(from, path.join(vendorDir, dst));
  const size = (statSync(from).size / 1024 / 1024).toFixed(1);
  console.log('✓ vendor/' + dst + '  (' + size + ' MB)');
}
console.log('vendor 打包完成');
