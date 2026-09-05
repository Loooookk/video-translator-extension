/* 端到端测试：字幕识别模式（真实 Chrome + 扩展 + CDP）
 * 流程：测试页播放视频 → 在 popup 页（扩展上下文）下发 captions-start
 *      → 内容脚本轮询字幕 → 唤醒 SW 翻译 → 验证浮层显示中文
 */
const DEBUG_PORT = 9333;
const EXT_ID = 'pilcmnalnfojjnihniogfpjpammphjie';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(path, method = 'GET') {
  const r = await fetch('http://127.0.0.1:' + DEBUG_PORT + path, { method });
  return r.json();
}

function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => res({
      send(method, params = {}) {
        return new Promise((rs, rj) => {
          const i = ++id;
          pending.set(i, { rs, rj });
          ws.send(JSON.stringify({ id: i, method, params }));
        });
      },
      close() { ws.close(); }
    });
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        m.error ? p.rj(new Error(m.error.message)) : p.rs(m.result);
      }
    };
    ws.onerror = e => rej(new Error('ws error'));
  });
}

async function main() {
  const targets = await getJSON('/json/list');
  const pageT = targets.find(t => t.type === 'page' && t.url.includes('test-page.html'));
  if (!pageT) { console.error('❌ 未找到测试页 target'); process.exit(1); }
  console.log('✓ 测试页:', pageT.url);

  const page = await connect(pageT.webSocketDebuggerUrl);
  await page.send('Runtime.enable');
  await page.send('Page.enable');

  const playRes = await page.send('Runtime.evaluate', {
    expression: 'document.getElementById("v").play().then(() => "playing")',
    awaitPromise: true, userGesture: true, returnByValue: true
  });
  console.log('播放状态:', JSON.stringify(playRes.result && playRes.result.value));
  const probe = async (label) => {
    const r = await page.send('Runtime.evaluate', {
      expression: 'JSON.stringify({cur: document.getElementById("v").currentTime, paused: document.getElementById("v").paused, hidden: document.hidden})',
      returnByValue: true
    });
    console.log('  [' + label + '] ' + r.result.value);
  };
  await sleep(1500);
  await probe('播放1.5s后');

  // 打开 popup 页作为扩展控制端
  let popupT = targets.find(t => t.type === 'page' && t.url === 'about:blank');
  if (!popupT) popupT = await getJSON('/json/new?url=about:blank', 'PUT');
  const popup = await connect(popupT.webSocketDebuggerUrl);
  await popup.send('Page.enable');
  await popup.send('Page.navigate', { url: 'chrome-extension://' + EXT_ID + '/popup/popup.html' });
  await sleep(1500);
  await probe('popup 打开后');
  console.log('✓ popup 控制页已打开');

  // 从 popup 上下文下发 captions-start
  const startRes = await popup.send('Runtime.evaluate', {
    expression: `(async () => {
      const tabs = await chrome.tabs.query({});
      const t = tabs.find(x => x.url && x.url.includes('test-page.html'));
      if (!t) return 'no-tab';
      const ping = await chrome.tabs.sendMessage(t.id, { type: 'ping' });
      const started = await chrome.tabs.sendMessage(t.id, { type: 'captions-start', targetLang: 'zh-CN' });
      return { tabId: t.id, ping, started };
    })()`,
    awaitPromise: true, returnByValue: true
  });
  console.log('captions-start 返回:', JSON.stringify(startRes.result && startRes.result.value));

  await sleep(7000);
  const overlay = await page.send('Runtime.evaluate', {
    expression: `(() => {
      const host = document.getElementById('vt-overlay-host');
      if (!host) return 'no-overlay';
      const r = host.shadowRoot;
      return {
        zh: r.querySelector('.vt-sub .zh').textContent,
        orig: r.querySelector('.vt-sub .orig').textContent,
        badge: getComputedStyle(r.querySelector('.vt-badge')).display,
        subDisplay: getComputedStyle(r.querySelector('.vt-sub')).display
      };
    })()`,
    returnByValue: true
  });
  console.log('浮层状态:', JSON.stringify(overlay.result.value, null, 2));

  page.close();
  popup.close();
  const v = overlay.result.value;
  const pass = v && typeof v.zh === 'string' && v.zh.length > 0 && /[\u4e00-\u9fff]/.test(v.zh);
  console.log(pass ? '\n✅ 字幕翻译端到端测试通过：' + v.zh : '\n❌ 测试未通过');
  process.exit(pass ? 0 : 1);
}

main().catch(e => { console.error('异常:', e.message); process.exit(1); });
