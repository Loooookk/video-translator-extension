/* 视频实时翻译 - 内容脚本
 * 职责：检测正在播放的视频、显示中文翻译字幕浮层、字幕识别模式（读取视频自带 WebVTT 字幕并请求翻译）
 */
(() => {
  'use strict';

  const videos = new Set();
  const playingVideos = new Set();
  let primary = null;
  let overlay = null;       // shadow host
  let badgeEl, subEl, zhEl, origEl, statusEl, logEl;
  let captionsEnabled = false;
  let captionsTimer = null;
  let lastCaptionText = '';
  let seq = 0;
  let pendingCaptionSeq = 0;
  let pendingAudioSeq = 0;
  let lastSub = null;
  let lastShownText = '';
  let rafId = null;
  let settings = { fontSize: 22 };
  let audioModeActive = false;
  const captionTrackHandlers = new Map();
  const originalTrackModes = new Map();
  const prefetched = new Map();
  let sessionId = null;
  let sourceLanguage = 'auto';
  let captionKey = '';
  let completedAudioSeq = 0, completedCaptionSeq = 0;
  let captionStartedAt = 0;
  const DOM_CAPTIONS = '.ytp-caption-segment, .bpx-player-subtitle-panel-text, .vjs-text-track-cue';
  const subtitleTrack = t => t.kind === 'subtitles' || t.kind === 'captions';
  const videoIds = new WeakMap();
  let videoIdCounter = 0;
  let mediaSession = null, lockedVideo = null, sourceLocked = false, targetLostReported = false;
  const managedMedia = new Map();
  let mediaHandshakeEpoch = 0;
  let playbackEpoch = 0;

  try {
    chrome.storage.local.get({ vtSettings: null }, (r) => {
      if (r && r.vtSettings) settings = Object.assign(settings, r.vtSettings);
    });
  } catch (e) {}

  /* ================= 视频检测 ================= */
  function addVideo(v) {
    if (videos.has(v)) return;
    videos.add(v);
    videoIds.set(v, String(++videoIdCounter));
    manageMedia(v);
    v.addEventListener('play', onPlay, true);
    v.addEventListener('playing', onPlay, true);
    v.addEventListener('pause', onPause, true);
    v.addEventListener('emptied', onPause, true);
    v.addEventListener('seeking', resetPlayback, true);
    v.addEventListener('emptied', resetPlayback, true);
    if (!v.paused && !v.ended) onPlay({ target: v });
  }

  function onPlay(e) {
    const v = e.target;
    if (!v || v.tagName !== 'VIDEO') return;
    playingVideos.add(v);
    updatePrimary();
    showBadge();
    reportFrame();
  }

  function onPause(e) {
    const v = e.target;
    if (!v || v.tagName !== 'VIDEO') return;
    playingVideos.delete(v);
    updatePrimary();
    if (playingVideos.size === 0 && !captionsEnabled) hideBadge();
    reportFrame();
  }

  function scan(root) {
    if (root && root.querySelectorAll) {
      root.querySelectorAll('video').forEach(addVideo);
    }
  }

  function updatePrimary() {
    let best = null, bestArea = 0;
    for (const v of videos) {
      if (!v.isConnected) { playingVideos.delete(v); videos.delete(v); continue; }
      if (v.paused || v.ended) { playingVideos.delete(v); continue; }
      playingVideos.add(v);
      const r = v.getBoundingClientRect();
      const a = r.width * r.height;
      if (a > bestArea) { bestArea = a; best = v; }
    }
    if (sourceLocked) {
      if (lockedVideo && !lockedVideo.isConnected) {
        lockedVideo = null;
        clearSubtitle();
        hideBadge();
        if (!targetLostReported && mediaSession) {
          targetLostReported = true;
          chrome.runtime.sendMessage({ type: 'vt-target-lost', sessionId: mediaSession.sessionId }).catch(() => {});
        }
      }
      primary = lockedVideo;
      return;
    }
    if (primary !== best && captionsEnabled) clearCaption();
    primary = best;
  }

  function domCaption() {
    const player = primary?.closest('.html5-video-player, .bpx-player-container, .video-js');
    if (!player) return '';
    return [...player.querySelectorAll(DOM_CAPTIONS)].filter(node => node.getClientRects().length)
      .map(node => node.textContent).join(' ').replace(/\s+/g, ' ').trim();
  }
  function candidateInfo(video) {
    const rect = video.getBoundingClientRect();
    const left = rect.left || 0, top = rect.top || 0;
    const width = Math.max(0, Math.min(left + rect.width, window.innerWidth) - Math.max(0, left));
    const height = Math.max(0, Math.min(top + rect.height, window.innerHeight) - Math.max(0, top));
    return { videoId: videoIds.get(video), width: Math.round(rect.width), height: Math.round(rect.height),
      area: Math.round(width * height), playing: !video.paused && !video.ended,
      hasCaptions: [...video.textTracks || []].some(subtitleTrack) || (video === primary && !!domCaption()) };
  }
  function deactivatePage() {
    sessionId = null;
    audioModeActive = false;
    releaseMediaSession();
    stopCaptions();
    clearSubtitle();
    hideBadge();
  }

  function resetPlayback(event) {
    if (!mediaSession || !sourceLocked || event.target !== lockedVideo) return;
    playbackEpoch += 1;
    clearCaption();
    prefetched.clear();
    pendingAudioSeq = 0;
    completedAudioSeq = 0;
    try {
      chrome.runtime.sendMessage({ type: 'vt-playback-reset', sessionId, playbackEpoch }).catch(() => {});
    } catch { deactivatePage(); }
  }

  function reportFrame() {
    updatePrimary();
    const rect = primary?.getBoundingClientRect();
    const hasCaptions = !!primary && ([...primary.textTracks || []].some(subtitleTrack) || !!domCaption());
    const info = { type: 'vt-frame-state', videos: videos.size, playing: playingVideos.size,
      area: rect ? Math.round(rect.width * rect.height) : 0, hasCaptions,
      candidates: [...videos].filter(video => video.isConnected).map(candidateInfo) };
    const handshakeEpoch = mediaHandshakeEpoch;
    try {
      chrome.runtime.sendMessage(info).then(response => {
        if (handshakeEpoch !== mediaHandshakeEpoch || !mediaSession) return;
        if (response?.active === false || (response?.sessionId && response.sessionId !== sessionId)) deactivatePage();
      }).catch(() => {
        if (handshakeEpoch === mediaHandshakeEpoch && mediaSession) deactivatePage();
      });
    } catch { deactivatePage(); }
    return info;
  }
  setInterval(reportFrame, 2000);

  function manageMedia(media) {
    if (!mediaSession || mediaSession.mode !== 'audio') return;
    const selected = media === lockedVideo;
    if (!selected && !mediaSession.isolateAudio) return;
    let entry = managedMedia.get(media);
    if (!entry) {
      entry = { original: media.muted, applied: null, listener: () => {
        if (mediaSession?.mode === 'audio' && mediaSession.isolateAudio && media !== lockedVideo && !media.muted) media.muted = true;
      } };
      managedMedia.set(media, entry);
      media.addEventListener('volumechange', entry.listener);
    }
    const desired = !selected;
    // Let the user control the main player's mute button after initial selection.
    if (entry.applied !== desired || (!selected && !media.muted)) {
      entry.applied = desired;
      try { media.muted = desired; } catch {}
    }
  }
  function manageAllMedia() {
    for (const media of new Set([...videos, ...document.querySelectorAll('audio')])) manageMedia(media);
  }
  function releaseMediaSession() {
    mediaHandshakeEpoch++;
    mediaSession = null;
    for (const [media, entry] of managedMedia) {
      media.removeEventListener('volumechange', entry.listener);
      try { if (media.muted === entry.applied) media.muted = entry.original; } catch {}
    }
    managedMedia.clear();
    sourceLocked = false; lockedVideo = null; targetLostReported = false;
  }
  function beginMediaSession(message) {
    if (mediaSession?.sessionId === message.sessionId) return;
    stopCaptions();
    releaseMediaSession();
    sessionId = message.sessionId;
    playbackEpoch = message.playbackEpoch ?? 0;
    mediaSession = { sessionId, mode: message.mode, isolateAudio: message.isolateAudio !== false };
    sourceLocked = true; primary = null; audioModeActive = false;
    hideBadge();
    manageAllMedia();
  }
  function lockSource(message) {
    const selected = message.targetVideoId
      ? [...videos].find(video => video.isConnected && videoIds.get(video) === message.targetVideoId)
      : primary || [...playingVideos].find(video => video.isConnected);
    if (!selected) return false;
    mediaHandshakeEpoch++;
    lockedVideo = selected; primary = selected; sourceLocked = true;
    targetLostReported = false;
    manageAllMedia();
    showBadge();
    return true;
  }

  const mo = new MutationObserver(muts => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) {
          if (n.tagName === 'VIDEO') addVideo(n);
          else scan(n);
          if (n.tagName === 'AUDIO') manageMedia(n);
          n.querySelectorAll?.('audio').forEach(manageMedia);
        }
      }
      if (sourceLocked && m.removedNodes?.length) updatePrimary();
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  scan(document);

  /* ================= 字幕浮层（Shadow DOM 隔离页面样式） ================= */
  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'vt-overlay-host';
    overlay.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
    const root = overlay.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = [
      ".vt-badge{position:fixed;display:none;pointer-events:auto;cursor:pointer;background:rgba(15,23,42,.85);color:#fff;font:12px/1.5 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;padding:5px 12px;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.4);white-space:nowrap;transition:background .15s;}",
      ".vt-badge:hover{background:rgba(37,99,235,.95);}",
      ".vt-sub{position:fixed;display:none;left:50%;transform:translateX(-50%);bottom:7vh;max-width:min(86vw,780px);pointer-events:none;text-align:center;z-index:2147483647;}",
      ".vt-sub .zh{display:inline;background:rgba(15,23,42,.8);color:#fff;font:700 22px/1.55 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;padding:6px 18px;border-radius:10px;box-shadow:0 2px 14px rgba(0,0,0,.45);box-decoration-break:clone;-webkit-box-decoration-break:clone;}",
      ".vt-sub .orig{display:inline-block;margin-top:5px;color:#fde68a;font:500 13px/1.5 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;background:rgba(15,23,42,.6);padding:2px 12px;border-radius:8px;box-decoration-break:clone;-webkit-box-decoration-break:clone;max-width:100%;word-break:break-word;}",
      ".vt-note{position:fixed;display:none;top:10px;right:10px;background:rgba(15,23,42,.85);color:#7dd3fc;font:12px/1.5 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;padding:6px 14px;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.4);z-index:2147483647;max-width:60vw;}",
      ".vt-log{position:fixed;display:none;top:10px;left:10px;max-width:min(70vw,560px);background:rgba(15,23,42,.78);color:#a5f3fc;font:11px/1.7 'SF Mono',Menlo,monospace;padding:6px 10px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.4);z-index:2147483647;word-break:break-all;}"
    ].join('\n');
    root.appendChild(style);

    badgeEl = document.createElement('div');
    badgeEl.className = 'vt-badge';
    badgeEl.textContent = '🎬 检测到视频 · 点击扩展图标开始翻译';
    badgeEl.addEventListener('click', () => { flash('请在浏览器工具栏点击本扩展图标，然后点「开始翻译」'); });

    subEl = document.createElement('div');
    subEl.className = 'vt-sub';
    zhEl = document.createElement('div');
    zhEl.className = 'zh';
    origEl = document.createElement('div');
    origEl.className = 'orig';
    subEl.appendChild(zhEl);
    subEl.appendChild(origEl);

    statusEl = document.createElement('div');
    statusEl.className = 'vt-note';
    logEl = document.createElement('div');
    logEl.className = 'vt-log';

    root.appendChild(badgeEl);
    root.appendChild(subEl);
    root.appendChild(statusEl);
    root.appendChild(logEl);
    document.documentElement.appendChild(overlay);
    document.addEventListener('fullscreenchange', onFullscreenChange, true);
    applyLayout();
    return overlay;
  }

  function onFullscreenChange() {
    if (!overlay) return;
    const target = document.fullscreenElement || document.documentElement;
    if (overlay.parentNode !== target) {
      try { target.appendChild(overlay); } catch (e) {}
    }
    if (primary) showBadge();
  }

  function showBadge() {
    if (!primary) return;
    ensureOverlay();
    badgeEl.style.display = 'block';
    positionBadge();
    startRaf();
  }

  function hideBadge() {
    if (badgeEl) badgeEl.style.display = 'none';
  }

  function positionBadge() {
    if (!primary || !badgeEl) return;
    const r = primary.getBoundingClientRect();
    badgeEl.style.left = Math.max(8, Math.min(r.right - 210, window.innerWidth - 218)) + 'px';
    badgeEl.style.top = Math.max(8, r.top + 10) + 'px';
  }

  function positionSubtitle() {
    if (!primary || !subEl) return;
    const rect = primary.getBoundingClientRect();
    const left = Math.max(0, rect.left || 0);
    const right = Math.min(window.innerWidth, (rect.left || 0) + rect.width);
    const top = Math.max(0, rect.top || 0);
    const bottom = Math.min(window.innerHeight, (rect.top || 0) + rect.height);
    const width = Math.max(0, right - left), height = Math.max(0, bottom - top);
    subEl.style.visibility = width && height ? 'visible' : 'hidden';
    subEl.style.left = (left + width / 2) + 'px';
    subEl.style.bottom = (window.innerHeight - bottom + Math.max(12, height * 0.06)) + 'px';
    subEl.style.maxWidth = Math.min(780, width * 0.92) + 'px';
  }

  function startRaf() {
    if (rafId) return;
    const tick = () => {
      if (badgeEl && badgeEl.style.display !== 'none') positionBadge();
      if (subEl && subEl.style.display === 'block') positionSubtitle();
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  let subHideTimer = null;
  /* 重置字幕自动隐藏计时：12 秒无新内容则淡出，避免旧字幕一直挂着像卡死 */
  function armSubHide() {
    clearTimeout(subHideTimer);
    subHideTimer = setTimeout(() => { if (subEl) subEl.style.display = 'none'; }, 12000);
  }

  /* 字符 bigram Jaccard 相似度 */
  function textSimilarity(a, b) {
    const bg = (s) => {
      const m = new Set();
      for (let i = 0; i < s.length - 1; i++) m.add(s.slice(i, i + 2));
      return m;
    };
    const A = bg(a), B = bg(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    return inter / Math.min(A.size, B.size);
  }

  function showSubtitle(original, translated) {
    if (!translated) return;
    const t = translated.trim();
    lastShownText = t;
    ensureOverlay();
    zhEl.textContent = translated;
    zhEl.style.fontSize = (settings.fontSize || 22) + 'px';
    origEl.textContent = original || '';
    origEl.style.display = original ? 'inline-block' : 'none';
    subEl.style.display = 'block';
    positionSubtitle();
    armSubHide();
    lastSub = { original, translated };
  }

  /* 识别完成但翻译还没回来：先显示原文；已有翻译时保留旧翻译不被占位符覆盖 */
  function showPending(original) {
    if (!original) return;
    ensureOverlay();
    origEl.textContent = original;
    origEl.style.display = 'inline-block';
    zhEl.textContent = '翻译中…';
    zhEl.style.fontSize = (settings.fontSize || 22) + 'px';
    subEl.style.display = 'block';
    positionSubtitle();
    armSubHide();
    lastSub = null;
  }

  /* 布局：翻译上-原文下（默认）或反过来 */
  function applyLayout() {
    if (!subEl || !zhEl || !origEl) return;
    const transTop = settings.layout !== 'orig-top';
    if (transTop) {
      if (subEl.firstChild !== zhEl) { subEl.insertBefore(zhEl, subEl.firstChild); }
    } else {
      if (subEl.firstChild !== origEl) { subEl.insertBefore(origEl, subEl.firstChild); }
    }
  }

  function flash(text) {
    ensureOverlay();
    statusEl.textContent = text;
    statusEl.style.display = 'block';
    clearTimeout(flash._t);
    flash._t = setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
  }

  /* 流水日志：显示在页面左上角，方便观察管线运行到哪一步 */
  function addTrace(text) {
    if (!text) return;
    ensureOverlay();
    const line = document.createElement('div');
    line.textContent = text;
    logEl.appendChild(line);
    while (logEl.children.length > 8) logEl.removeChild(logEl.firstChild);
    logEl.style.display = 'block';
  }

  /* ================= 字幕识别模式（读取视频自带字幕） ================= */
  function startCaptions(targetLang) {
    stopCaptions();
    captionsEnabled = true;
    lastCaptionText = '';
    captionStartedAt = Date.now();
    captionsTimer = setInterval(pollCaptions, 100);
    pollCaptions();
    flash('字幕翻译已开启（使用视频自带字幕）');
  }

  function stopCaptions() {
    captionsEnabled = false;
    clearCaption();
    if (captionsTimer) { clearInterval(captionsTimer); captionsTimer = null; }
    for (const [track, listener] of captionTrackHandlers) {
      try { track.removeEventListener('cuechange', listener); } catch (e) {}
    }
    captionTrackHandlers.clear();
    for (const [track, mode] of originalTrackModes) {
      try { if (track.mode === 'hidden') track.mode = mode; } catch {}
    }
    originalTrackModes.clear();
    prefetched.clear();
    lastCaptionText = '';
  }

  function clearSubtitle() {
    clearTimeout(subHideTimer);
    if (subEl) subEl.style.display = 'none';
    lastSub = null; lastShownText = '';
  }
  function clearCaption() {
    pendingCaptionSeq = ++seq;
    captionKey = ''; lastCaptionText = '';
    clearSubtitle();
    if (sessionId) {
      try { chrome.runtime.sendMessage({ type: 'caption-cancel', sessionId, playbackEpoch }).catch(() => {}); }
      catch { deactivatePage(); }
    }
  }

  function attachCaptionTrack(track) {
    if (!track || captionTrackHandlers.has(track)) return;
    const onCueChange = () => {
      if (captionsEnabled) pollCaptions();
    };
    track.addEventListener('cuechange', onCueChange);
    captionTrackHandlers.set(track, onCueChange);
  }

  function currentVideoTime() {
    const v = primary || [...playingVideos][0];
    return v && typeof v.currentTime === 'number' ? v.currentTime : 0;
  }

  function readActiveCaption(track, t) {
    if (!track || !track.cues) return null;
    const cues = track.cues;
    const time = t == null ? currentVideoTime() : t;
    const active = track.activeCues?.length ? [...track.activeCues]
      : [...cues].filter(c => time >= c.startTime && time < c.endTime);
    if (!active.length) return null;
    const text = active.map(c => c.getCueAsHTML ? c.getCueAsHTML().textContent : c.text || '').join('\n');
    return { text, lang: track.language || '', key: active.map(c => c.startTime + ':' + c.endTime).join('|') + '|' + text };
  }

  function handleCaption(rawText, lang, key = rawText) {
    const clean = rawText.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (!clean || key === captionKey) return;
    captionKey = key;
    lastCaptionText = clean;
    const mySeq = ++seq;
    pendingCaptionSeq = mySeq;
    const mySession = sessionId;
    const myEpoch = playbackEpoch;
    showPending(clean);
    chrome.runtime.sendMessage({ type: 'caption', sessionId, playbackEpoch, text: clean, lang, targetLang: currentTargetLang(), seq: mySeq }, (resp) => {
      if (!captionsEnabled || sessionId !== mySession || playbackEpoch !== myEpoch || pendingCaptionSeq !== mySeq) return;
      if (chrome.runtime.lastError || !resp?.ok) {
        if (resp?.ignored) { clearSubtitle(); return; }
        if (resp?.cancelled) return;
        showSubtitle(clean, '翻译未完成，原文如下');
        if (resp?.error) flash(resp.error);
        return;
      }
      completedCaptionSeq = mySeq;
      showSubtitle(clean, resp.translated);
    });
  }

  function prefetchCaptions(track, time) {
    const cues = track.cues;
    if (!cues?.length) return;
    let low = 0, high = cues.length;
    while (low < high) { const mid = (low + high) >>> 1; if (cues[mid].startTime <= time) low = mid + 1; else high = mid; }
    for (let i = low; i < Math.min(cues.length, low + 2); i++) {
      const cue = cues[i];
      if (cue.startTime > time + 12) break;
      const text = (cue.getCueAsHTML ? cue.getCueAsHTML().textContent : cue.text).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      const key = track.language + '|' + text;
      const previous = prefetched.get(key);
      if (!text || previous === true || (previous && Date.now() - previous < 3000)) continue;
      prefetched.set(key, Date.now());
      if (prefetched.size > 80) prefetched.delete(prefetched.keys().next().value);
      const currentSession = sessionId;
      const currentEpoch = playbackEpoch;
      chrome.runtime.sendMessage({ type: 'caption', sessionId, playbackEpoch, prefetch: true, text, lang: track.language || '' }, response => {
        if (!chrome.runtime.lastError && response?.ok && currentSession === sessionId && currentEpoch === playbackEpoch && prefetched.has(key)) prefetched.set(key, true);
      });
    }
  }

  function pollCaptions() {
    if (!captionsEnabled) return;
    updatePrimary();
    const v = primary;
    if (!v) { if (captionKey) clearCaption(); return; }
    const tracks = [...v.textTracks || []].filter(subtitleTrack);
    const track = tracks.find(t => sourceLanguage !== 'auto' && t.language?.split('-')[0] === sourceLanguage)
      || tracks.find(t => t.mode === 'showing') || tracks[0];
    if (track) {
      if (track.mode === 'disabled') {
        if (!originalTrackModes.has(track)) originalTrackModes.set(track, track.mode);
        try { track.mode = 'hidden'; } catch {}
      }
      attachCaptionTrack(track);
      const item = readActiveCaption(track, v.currentTime);
      prefetchCaptions(track, v.currentTime);
      if (item && item.text) {
        handleCaption(item.text, item.lang, item.key);
        return;
      }
    }
    const text = domCaption();
    if (text) { handleCaption(text, '', 'dom|' + text); return; }
    if (captionKey) clearCaption();
    if (Date.now() - captionStartedAt > 8000) {
      flash('尚未读到字幕，请在播放器中打开字幕；无字幕视频请用音频识别');
      captionStartedAt = Date.now();
    }
  }

  let targetLangValue = 'zh-CN';
  function currentTargetLang() { return targetLangValue; }

  /* ================= 消息处理 ================= */
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'ping': {
        let videosCount = 0, hasCaptions = false;
        for (const v of videos) if (v.isConnected) videosCount++;
        for (const v of videos) {
          for (const t of v.textTracks || []) {
            if (t.kind === 'subtitles' || t.kind === 'captions') { hasCaptions = true; break; }
          }
          if (hasCaptions) break;
        }
        sendResponse({ ok: true, videos: videosCount, hasCaptions, playing: playingVideos.size });
        return;
      }
      case 'vt-probe':
        sendResponse({ ok: true, ...reportFrame() });
        return;
      case 'media-session-start':
        beginMediaSession(msg);
        sendResponse({ ok: true });
        return;
      case 'translation': {
        if (msg.sessionId !== sessionId || (msg.playbackEpoch ?? 0) !== playbackEpoch) break;
        if ((msg.source || 'audio') === 'caption') {
          if (!captionsEnabled || msg.seq !== pendingCaptionSeq) break;
          if (msg.partial && msg.seq === completedCaptionSeq) break;
          if (!msg.partial) completedCaptionSeq = msg.seq;
        } else {
          if (!audioModeActive) break;
          if (sourceLocked && (!lockedVideo || !lockedVideo.isConnected)) { updatePrimary(); break; }
          if (!primary || !primary.isConnected || primary.paused) {
            updatePrimary();
            if (!primary && videos.size) {
              for (const v of videos) {
                if (v && v.isConnected && !v.paused && !v.ended) { primary = v; break; }
              }
              if (!primary) {
                for (const v of videos) {
                  if (v && v.isConnected) { primary = v; break; }
                }
              }
            }
          }
          if (msg.seq && msg.seq < pendingAudioSeq) break;
          if (msg.seq) pendingAudioSeq = msg.seq;
          if (msg.partial && msg.seq === completedAudioSeq) break;
          if (!msg.partial) completedAudioSeq = msg.seq;
        }
        if (!primary) break;
        if (window !== window.top) {
          // 嵌入 frame：视频过小（<12% 视口）视为广告位，不显示
          const r = primary.getBoundingClientRect();
          const ratio = (r.width * r.height) / (window.innerWidth * window.innerHeight);
          if (ratio < 0.12) break;
        }
        showSubtitle(msg.original, msg.untranslated ? '翻译失败，原文如下' : msg.translated);
        break;
      }
      case 'translation-pending': {
        if (!audioModeActive || msg.sessionId !== sessionId || (msg.playbackEpoch ?? 0) !== playbackEpoch || msg.seq < pendingAudioSeq) break;
        pendingAudioSeq = msg.seq;
        updatePrimary();
        if (primary) showPending(msg.original);
        break;
      }
      case 'captions-start':
        if (sessionId !== msg.sessionId) playbackEpoch = msg.playbackEpoch ?? 0;
        if (msg.mode) beginMediaSession(msg);
        if (!lockSource(msg)) { sendResponse({ ok: false, error: '所选视频已移除，请重新选择' }); break; }
        audioModeActive = false;
        sessionId = msg.sessionId;
        sourceLanguage = msg.sourceLang || 'auto';
        targetLangValue = msg.targetLang || 'zh-CN';
        startCaptions(targetLangValue);
        sendResponse({ ok: true });
        break;
      case 'captions-stop':
        if (msg.sessionId && msg.sessionId !== sessionId) break;
        stopCaptions();
        releaseMediaSession();
        sessionId = null;
        sendResponse({ ok: true });
        break;
      case 'audio-mode-on':
        if (sessionId !== msg.sessionId) playbackEpoch = msg.playbackEpoch ?? 0;
        if (msg.mode) beginMediaSession(msg);
        stopCaptions();
        if (!lockSource(msg)) { sendResponse({ ok: false, error: '所选视频已移除，请重新选择' }); break; }
        sessionId = msg.sessionId;
        pendingAudioSeq = 0;
        completedAudioSeq = 0;
        audioModeActive = true;
        reportFrame();
        sendResponse({ ok: true });
        break;
      case 'audio-mode-off':
        if (msg.sessionId && msg.sessionId !== sessionId) break;
        audioModeActive = false;
        releaseMediaSession();
        clearSubtitle();
        sendResponse({ ok: true });
        break;
      case 'ensure-audible': {
        const v = primary || [...playingVideos][0];
        if (v && v.muted) { try { v.muted = false; } catch (e) {} }
        sendResponse({ ok: true, unmuted: !!(v && v.muted === false) });
        break;
      }
      case 'vt-settings': {
        if (msg.settings) {
          if (msg.settings.fontSize) settings.fontSize = msg.settings.fontSize;
          if (msg.settings.layout) settings.layout = msg.settings.layout;
          applyLayout();
          if (lastSub) showSubtitle(lastSub.original, lastSub.translated);
        }
        break;
      }
      case 'vt-status': {
        const st = msg.status;
        if (!st) break;
        if (st.state === 'loading') flash('语音模型加载中 ' + Math.round(st.progress || 0) + '%');
        else if (st.state === 'listening') flash('正在实时翻译…');
        else if (st.state === 'error') flash('⚠ ' + (st.detail || '出错'));
        else if (st.state === 'hint') flash(st.detail || '');
        else if (st.state === 'trace') addTrace(st.detail);
        break;
      }
    }
  });
  // A new advertising iframe must join an already-running isolation session.
  const handshakeEpoch = mediaHandshakeEpoch;
  chrome.runtime.sendMessage({ type: 'media-session-info' }, response => {
    if (chrome.runtime.lastError || !response?.active || mediaSession || handshakeEpoch !== mediaHandshakeEpoch) return;
    beginMediaSession(response.state);
    if (response.isTarget && lockSource(response.state)) {
      if (response.state.mode === 'audio') audioModeActive = true;
      else { sourceLanguage = response.state.sourceLang || 'auto'; targetLangValue = response.state.targetLang || 'zh-CN'; startCaptions(targetLangValue); }
    }
  });
})();
