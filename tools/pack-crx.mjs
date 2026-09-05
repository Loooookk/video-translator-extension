/* 将扩展打包为 .crx（CRX3 格式，自签名，供 Yandex/Edge 拖拽安装尝试）
 * 用法：node tools/pack-crx.mjs
 * 说明：新版 Chromium 内核浏览器常拒绝本地 crx 拖拽安装，失败请改用「加载已解压的扩展程序」
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(root, '..');
const outFile = path.join(outDir, 'video-translator-extension.crx');
const zipFile = '/tmp/vt-extension-pack.zip';

console.log('1/3 打包扩展文件（排除 node_modules / test / tools / scripts）…');
try { execFileSync('rm', ['-f', zipFile]); } catch (e) {}
execFileSync('zip', [
  '-r', '-q', '-X', zipFile,
  'manifest.json', 'background.js', 'content', 'offscreen', 'popup', 'icons', 'vendor',
  '-x', '*.DS_Store', '*/.DS_Store'
], { cwd: root });

const zip = readFileSync(zipFile);
console.log('2/3 生成 RSA 密钥并签名（CRX3 头）…');
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'der' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});
const signature = crypto.sign('sha256', zip, privateKey);

// 手写 protobuf 编码（CrxFileHeader）
const varint = (n) => {
  const out = [];
  while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); }
  out.push(n);
  return Buffer.from(out);
};
const lenDelim = (field, data) => Buffer.concat([varint(field << 3 | 2), varint(data.length), data]);
// AsymmetricKeyProof: field 1 = public_key, field 2 = signature
const proof = Buffer.concat([lenDelim(1, publicKey), lenDelim(2, signature)]);
// CrxFileHeader: field 2 = sha256_with_rsa（可重复）
const header = lenDelim(2, proof);

const magic = Buffer.from('Cr24', 'ascii');
const version = Buffer.alloc(4); version.writeUInt32LE(3, 0);
const hlen = Buffer.alloc(4); hlen.writeUInt32LE(header.length, 0);
const crx = Buffer.concat([magic, version, hlen, header, zip]);

writeFileSync(outFile, crx);
console.log('3/3 完成 →', outFile, '(' + (crx.length / 1024 / 1024).toFixed(1) + ' MB)');
console.log('');
console.log('安装方法：Yandex 打开 browser://extensions → 开开发者模式 → 把此 .crx 文件');
console.log('直接拖进该页面 → 弹窗点「添加扩展程序」。若提示被阻止，请改用「加载已解压的扩展程序」。');
