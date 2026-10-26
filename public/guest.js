// Guest page: name, camera/gallery pickers, upload queue that survives bad signal, live gallery.
(() => {
  const $ = (id) => document.getElementById(id);
  const slug = location.pathname.split('/')[2] || '';
  const API = `/api/events/${slug}`;
  const MAX_BYTES = 95 * 1024 * 1024;
  const POLL_MS = 12000;          // check for new photos every 12 s while the page is on screen
  const IDLE_MS = 10 * 60 * 1000;  // and pause after 10 min without a tap or scroll
  const STALL_MS = 45000; // abort an upload that makes no progress for this long
  const TYPES = { nikah: 'Solemnisation', sanding: '', tandang: '', other: '' }; // receptions: "The wedding of" already says it

  // ---------- per-device state ----------
  const storeKey = `ga:${slug}`;
  const state = loadState();
  const urlToken = new URLSearchParams(location.search).get('t');
  if (urlToken) state.token = urlToken;
  // The couple's "View all photos" link carries their admin token after #couple=; keep it, then hide it from the address bar
  const coupleMatch = location.hash.match(/couple=([a-z0-9]+)/);
  if (coupleMatch) {
    state.coupleToken = coupleMatch[1];
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (!state.deviceId) state.deviceId = uuid();
  saveState();

  function loadState() {
    try { return JSON.parse(localStorage.getItem(storeKey)) || {}; } catch { return {}; }
  }
  function saveState() {
    try { localStorage.setItem(storeKey, JSON.stringify(state)); } catch {}
  }
  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  const api = (path, opts = {}) =>
    fetch(API + path, { ...opts, headers: {
      'X-Guest-Token': state.token || '',
      ...(state.guestId ? { 'X-Guest-Id': state.guestId } : {}),
      ...(state.coupleToken ? { 'X-Admin-Token': state.coupleToken } : {}),
      ...(opts.headers || {}),
    } })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: r.status, code: data.code });
        return data;
      });

  // ---------- small UI helpers ----------
  const show = (el, on = true) => el.classList.toggle('hidden', !on);
  let toastTimer;
  function toast(text) {
    $('toast').textContent = text;
    show($('toast'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => show($('toast'), false), 4500);
  }
  function problem(text) {
    $('problem').textContent = text;
    show($('problem'));
    show($('join'), false);
    show($('share'), false);
  }

  // ---------- entrance (once per visit): frame -> instant photo -> lace envelope letter ----------
  const ENT_KEY = `ga-ent:${slug}`;
  let entranceOn = false;
  try {
    entranceOn = !!state.token && !state.coupleToken && !sessionStorage.getItem(ENT_KEY);
  } catch { entranceOn = !!state.token && !state.coupleToken; }
  if (entranceOn) { show($('entrance')); document.body.style.overflow = 'hidden'; }

  const reduceMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
  const running = new Set();
  function anim(el, frames, opts = {}) {
    const a = el.animate(frames, {
      fill: 'both', easing: 'cubic-bezier(.2, .7, .2, 1)', ...opts,
      duration: reduceMotion ? 0 : (opts.duration || 600),
      delay: reduceMotion ? 0 : (opts.delay || 0),
    });
    running.add(a);
    a.finished.finally(() => running.delete(a));
    return a.finished.catch(() => {});
  }
  const fastForward = () => running.forEach((a) => { try { a.finish(); } catch {} });
  const pause = (ms) => new Promise((r) => setTimeout(r, reduceMotion ? 0 : ms));

  let entStage = 'idle';
  let entEvent = null;

  function dropEntrance() {
    if (!entranceOn) return;
    entranceOn = false;
    show($('entrance'), false);
    document.body.style.overflow = '';
  }

  function leaveEntrance() {
    try { sessionStorage.setItem(ENT_KEY, '1'); } catch {}
    fastForward();
    const ent = $('entrance');
    ent.classList.add('leaving');
    document.body.style.overflow = '';
    setTimeout(() => { show(ent, false); ent.classList.remove('leaving'); }, 500);
    entranceOn = false;
    entStage = 'done';
    if (!$('join').classList.contains('hidden')) setTimeout(() => $('name').focus(), 520);
  }

  function buildEntrance(ev) {
    if (!entranceOn) return;
    entEvent = ev;
    const parts = ev.couple_names.split(/\s+(?:&|and|dan)\s+/i).map((p) => p.trim());
    const initials = parts.length === 2 ? [parts[0][0] || '', parts[1][0] || ''] : [ev.couple_names[0] || ''];
    $('ent-names').textContent = ev.couple_names;
    const d = new Date(ev.event_date + 'T00:00:00');
    $('ent-photo-date').textContent = d.toLocaleDateString('en-SG', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '.');
    const img = $('ent-photo-img');
    const strip = (ev.strip_urls || []).filter(Boolean);
    if (strip.length) {
      // photo-booth strip: one cell per photo, stacked above the date
      const photo = $('ent-photo');
      photo.classList.add('strip');
      img.remove();
      strip.forEach((url) => {
        const cell = document.createElement('div');
        cell.className = 'ent-photo-img ent-cell';
        cell.style.backgroundImage = `url("${url}")`;
        const chem = document.createElement('div'); chem.className = 'ent-chem';
        cell.append(chem);
        photo.insertBefore(cell, $('ent-photo-date'));
        new Image().src = url; // start loading now, while the frame is on screen
      });
    } else if (ev.cover_url) {
      img.classList.add('ent-cell');
      img.style.backgroundImage = `url("${ev.cover_url}")`;
      new Image().src = ev.cover_url; // start loading now, while the frame is on screen
    } else {
      img.classList.add('ent-cell');
      img.classList.add('no-photo');
      img.dataset.initials = initials.join('');
    }
    introFrame();
  }

  // a small magical butterfly that wanders around the photo booth screen, trailing sparkles
  function startButterfly() {
    const fly = $('ent-fly'), scene = $('ent-a');
    if (!fly || reduceMotion) return;
    fly.hidden = false;
    const ph = [0, 1, 2, 3].map(() => Math.random() * Math.PI * 2);
    const t0 = performance.now();
    let lastSpark = 0, prevX = null, facing = 1;
    const spark = (x, y) => {
      const s = document.createElement('span');
      s.className = 'ent-spark';
      s.style.left = `${x}px`; s.style.top = `${y}px`;
      scene.append(s);
      s.animate([
        { opacity: .95, transform: 'translate(-50%, -50%) scale(1) rotate(0deg)' },
        { opacity: 0, transform: `translate(-50%, ${Math.round(8 + Math.random() * 10)}px) scale(.2) rotate(90deg)` },
      ], { duration: 1100, easing: 'ease-out' }).finished.then(() => s.remove(), () => s.remove());
    };
    const step = (now) => {
      if (scene.classList.contains('hidden') || entStage === 'envelope' || entStage === 'done') { fly.hidden = true; return; }
      const t = (now - t0) / 1000, W = scene.clientWidth, H = scene.clientHeight;
      const x = W * (0.5 + 0.36 * Math.sin(t * 0.37 + ph[0]) + 0.08 * Math.sin(t * 1.3 + ph[1]));
      const y = H * (0.46 + 0.3 * Math.sin(t * 0.29 + ph[2]) + 0.06 * Math.sin(t * 1.7 + ph[3]));
      if (prevX !== null && Math.abs(x - prevX) > 0.25) facing = x > prevX ? 1 : -1;
      prevX = x;
      fly.style.transform = `translate(${x - 21}px, ${y - 17}px) rotate(${Math.sin(t * 2.1) * 9}deg) scaleX(${facing})`;
      if (now - lastSpark > 160) { lastSpark = now; spark(x - facing * 6, y + 7); }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  async function introFrame() {
    startButterfly();
    entStage = 'frame';
    const els = [$('ent-a').querySelector('.ent-pre'), $('ent-names')];
    els.forEach((el, n) => anim(el, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 700, delay: n * 120 }));
    anim($('ent-frame'), [{ opacity: 0, transform: 'scale(.94)' }, { opacity: 1, transform: 'none' }], { duration: 800, delay: 200 });
    anim($('ent-hint'), [{ opacity: 0 }, { opacity: 1 }], { duration: 600, delay: 1200 });
    setTimeout(() => { if (entStage === 'frame') $('ent-knob').classList.add('nudge'); }, reduceMotion ? 0 : 4500);
  }

  async function ejectPhoto() {
    if (entStage !== 'frame') return;
    entStage = 'photo';
    const knob = $('ent-knob');
    knob.classList.remove('nudge');
    knob.classList.add('pressed');
    setTimeout(() => knob.classList.remove('pressed'), 180);
    anim($('ent-hint'), [{ opacity: 1 }, { opacity: 0 }], { duration: 300 });
    const photoEl = $('ent-photo');
    const strip = photoEl.classList.contains('strip');
    const hidden = strip ? -(photoEl.offsetHeight + 6) : -172;
    const photo = anim(photoEl, [{ transform: `translateY(${hidden}px)` }, { transform: 'translateY(8px)' }],
      { duration: strip ? 2400 : 2000, delay: 200, easing: 'cubic-bezier(.4, .08, .25, 1)' });
    // each photo develops in turn, top to bottom
    const devs = [...photoEl.querySelectorAll('.ent-cell')].map((cell, i) => {
      const delay = 900 + i * 550;
      const chem = cell.querySelector('.ent-chem');
      if (chem) anim(chem, [{ opacity: 1 }, { opacity: 0 }], { duration: 2800, delay, easing: 'ease-out' });
      return anim(cell, [{ filter: 'sepia(1) brightness(.42) contrast(.7) blur(1.5px)' }, { filter: 'none' }], { duration: 2800, delay, easing: 'ease-out' });
    });
    await Promise.all([photo, ...devs]);
    // developed: drop the filter animations so nothing lingers on the photos (end state equals the plain style)
    photoEl.querySelectorAll('.ent-cell, .ent-chem').forEach((el) => el.getAnimations().forEach((a) => a.cancel()));
    await pause(1100);
    if (entStage === 'photo') toEnvelope();
  }

  function writeLetter() {
    const ev = entEvent;
    const parts = ev.couple_names.split(/\s+(?:&|and|dan)\s+/i).map((p) => p.trim());
    $('l-names').textContent = ev.couple_names;
    const body = ev.welcome_message ||
      'Thank you for being here and celebrating with us. Every photo, video and wish you share becomes part of our story, so please capture everything you see today.';
    // one span per word, so the letter can "write itself"
    const fillWords = (el, text) => {
      el.replaceChildren();
      text.split('\n').forEach((line, li) => {
        if (li) el.append(document.createElement('br'));
        line.split(/(\s+)/).forEach((tok) => {
          if (!tok) return;
          if (/^\s+$/.test(tok)) { el.append(tok); return; }
          const w = document.createElement('span'); w.className = 'w'; w.textContent = tok; el.append(w);
        });
      });
    };
    fillWords($('l-greet'), 'Dear guests,');
    fillWords($('l-body'), body);
    fillWords($('l-sign'), 'With love,');
    fillWords($('l-names'), parts.length === 2 ? `${parts[0]} & ${parts[1]}` : ev.couple_names);
    $('env-letter').querySelectorAll('.w').forEach((w) => { w.style.opacity = '0'; });
  }

  async function toEnvelope() {
    if (entStage === 'envelope' || entStage === 'done') return;
    entStage = 'envelope';
    fastForward();
    await anim($('ent-a'), [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.96)' }], { duration: 600, easing: 'ease-in' });
    show($('ent-a'), false);
    writeLetter();
    show($('ent-b'));
    $('entrance').scrollTop = 0;
    const letter = $('env-letter');
    // the letter sits in the pocket; give the envelope room above for however tall the letter is
    const env = $('env');
    const imgH = env.offsetWidth * 1.12;
    env.style.height = `${Math.ceil(Math.max(imgH, letter.offsetHeight + imgH * .303 + 10))}px`;
    const sink = Math.round(letter.offsetHeight + imgH * .303 - imgH * .2); // tucked fully inside the pocket
    anim($('env'), [{ opacity: 0, transform: 'translateY(24px)' }, { opacity: 1, transform: 'none' }], { duration: 800 });
    anim($('ent-go').parentElement, [{ opacity: 0 }, { opacity: 0 }], { duration: 1 });
    await anim(letter, [{ transform: `translateY(${sink}px)` }, { transform: 'none' }],
      { duration: 1500, delay: 500, easing: 'cubic-bezier(.25, .7, .25, 1)' });
    const words = [...letter.querySelectorAll('.w')];
    const step = Math.max(28, Math.min(70, 3600 / words.length)); // long messages write a little faster
    // plain fade per word: iPhones can leave blur filters stuck on inline text, so no filters here
    const writes = words.map((w, n) => anim(w, [{ opacity: 0 }, { opacity: 1 }], { duration: 420, delay: n * step, easing: 'ease-out' }));
    words.forEach((w) => { w.style.opacity = ''; });
    await Promise.all(writes);
    letter.getAnimations({ subtree: true }).forEach((a) => a.cancel()); // end state equals the plain style; drop the animation layers
    anim($('ent-go').parentElement, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 600, delay: 150 });
  }

  $('ent-knob').addEventListener('click', (e) => { e.stopPropagation(); ejectPhoto(); });
  $('ent-a').addEventListener('click', (e) => {
    if (entStage === 'frame' && e.target.closest('#ent-frame')) ejectPhoto();
    else if (entStage === 'photo') fastForward();
  });
  $('ent-b').addEventListener('click', (e) => { if (!e.target.closest('#ent-go')) fastForward(); });
  $('ent-go').onclick = leaveEntrance;
  $('ent-skip').onclick = leaveEntrance;

  // ---------- start ----------
  async function start() {
    let ev;
    // Weak signal is common at halls: retry a few times before giving up
    for (let attempt = 0; attempt < 4 && !ev; attempt++) {
      try {
        const r = await fetch(API, { cache: 'no-store' });
        if (r.status === 404) {
          dropEntrance();
          $('title').textContent = 'Album not found';
          $('when').textContent = 'Check the QR code or link and try again.';
          return;
        }
        if (!r.ok) throw new Error('server');
        ev = await r.json();
      } catch {
        if (attempt < 3) {
          $('title').textContent = 'Connecting…';
          await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
        }
      }
    }
    if (!ev) {
      dropEntrance();
      $('title').textContent = "Can't connect right now";
      $('when').innerHTML = 'Check your signal or Wi-Fi, then <button type="button" class="link-btn" id="retry">try again</button>.';
      $('retry').onclick = () => { $('when').textContent = ''; start(); };
      return;
    }
    paintHero(ev);
    buildEntrance(ev);

    if (!state.token) return problem('Please scan the QR code on your table to join this album.');
    // The couple skip the name step: anything they share is labelled with their names
    if (state.coupleToken) {
      // Only a real couple link counts: check it against the admin API before trusting it
      const ok = await fetch(`/api/admin/${slug}`, { headers: { 'X-Admin-Token': state.coupleToken } }).then((r) => r.ok, () => true);
      if (!ok) { delete state.coupleToken; saveState(); }
    }
    if (state.coupleToken && !(state.guestId && state.name)) {
      try { await join(ev.couple_names); } catch {}
    }
    if (state.guestId && state.name && !entered) enterShare();
    else show($('join'));
  }

  function applyTheme(theme) {
    const t = 'ha-florals';
    document.documentElement.className = `theme-${t}`;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = '#faf8f4';
    if (state.theme !== t) { state.theme = t; saveState(); }
  }

  function paintHero(ev) {
    document.title = `${ev.couple_names} · Guest Album`;
    // "Harris & Aqilah" -> two names stacked around a gold ampersand
    const parts = ev.couple_names.split(/\s+(?:&|and|dan)\s+/i);
    applyTheme(ev.theme);
    const names = $('names');
    names.textContent = '';
    const mono = document.createElement('span');
    mono.className = 'names-mono';
    mono.setAttribute('aria-hidden', 'true');
    names.append(mono);
    if (parts.length === 2) {
      const [a, b] = parts.map((p) => p.trim());
      const mk = (text, cls) => { const s = document.createElement('span'); s.textContent = text; if (cls) s.className = cls; return s; };
      names.append(mk(a), mk('&', 'amp'), mk(b));
      $('monogram').textContent = `${a[0] || ''}${b[0] || ''}`.toUpperCase();
    } else {
      const s = document.createElement('span');
      s.textContent = ev.couple_names;
      names.append(s);
      $('monogram').textContent = (ev.couple_names[0] || '').toUpperCase();
    }
    names.setAttribute('aria-label', ev.couple_names);

    $('occasion').textContent = TYPES[ev.event_type] || '';
    $('occasion').hidden = !$('occasion').textContent;
    const d = new Date(ev.event_date + 'T00:00:00');
    let when;
    try { when = d.toLocaleDateString('en-SG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
    catch { when = d.toLocaleDateString('en-SG', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
    $('when').textContent = when;
    $('where').textContent = ev.venue || '';
    $('wish-title').textContent = `Leave a wish for ${ev.couple_names}`;
    if (ev.privacy === 'private') {
      document.querySelector('#join .lead').textContent = "Share your photos and videos with the couple. Only they will see them. What's your name?";
    }

    const arch = $('arch');
    if (ev.cover_url) {
      arch.style.backgroundImage = `url("${ev.cover_url}")`;
      arch.classList.add('has-photo');
    }
    arch.setAttribute('aria-label', `${ev.couple_names}${ev.cover_url ? '' : ' monogram'}`);
    show(arch);
    $('hero').classList.add('ready');
  }

  // ---------- join ----------
  $('join').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button');
    const msg = $('join-msg');
    btn.disabled = true;
    msg.className = 'msg'; msg.textContent = '';
    try {
      await join($('name').value);
      enterShare();
    } catch (err) {
      if (err.code === 'bad_token') return problem('This link has expired. Please scan the QR code on your table again.');
      msg.className = 'msg err';
      msg.textContent = err.status ? err.message : 'No connection. Check your signal and try again.';
    } finally {
      btn.disabled = false;
    }
  });

  async function join(name) {
    const data = await api('/guests', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, device_id: state.deviceId }),
    });
    state.guestId = data.guest_id;
    state.name = data.name;
    saveState();
  }

  let entered = false;
  function enterShare() {
    entered = true;
    $('hero').classList.add('compact');
    show($('join'), false);
    show($('share'));
    $('who-name').textContent = state.name;
    loadGallery();
    resumeQueue();
  }

  $('change-name').onclick = () => {
    $('hero').classList.remove('compact');
    $('name').value = state.name || '';
    show($('share'), false);
    show($('join'));
    $('name').focus();
  };

  // ---------- pickers ----------
  document.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => $(b.dataset.pick).click()));
  ['pick-photo', 'pick-video', 'pick-gallery'].forEach((id) => {
    $(id).addEventListener('change', async (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      for (const f of files) await addFile(f);
    });
  });

  function guessType(file) {
    if (file.type) return file.type.toLowerCase();
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    return { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
             mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' }[ext] || '';
  }

  // ---------- preparing files ----------
  function drawToBlob(src, w, h, maxSide, quality) {
    const scale = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * scale));
    c.height = Math.max(1, Math.round(h * scale));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('encode'))), 'image/jpeg', quality));
  }

  async function preparePhoto(file, type) {
    try {
      const bmp = await createImageBitmap(file);
      const out = {
        blob: await drawToBlob(bmp, bmp.width, bmp.height, 2000, 0.82),
        thumb: await drawToBlob(bmp, bmp.width, bmp.height, 480, 0.7),
        w: Math.round(bmp.width * Math.min(1, 2000 / Math.max(bmp.width, bmp.height))),
        h: Math.round(bmp.height * Math.min(1, 2000 / Math.max(bmp.width, bmp.height))),
      };
      bmp.close && bmp.close();
      return out;
    } catch {
      // Browser can't decode it (e.g. HEIC outside Safari): send the original, no preview
      return { blob: file, thumb: null, w: null, h: null, type };
    }
  }

  function prepareVideo(file) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      const src = URL.createObjectURL(file);
      let settled = false;
      const finish = (thumb) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const out = { blob: file, thumb, w: v.videoWidth || null, h: v.videoHeight || null };
        v.removeAttribute('src'); v.load();
        URL.revokeObjectURL(src);
        resolve(out);
      };
      const timer = setTimeout(() => finish(null), 6000);
      v.muted = true; v.playsInline = true; v.preload = 'auto';
      v.onloadeddata = () => { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); };
      v.onseeked = () => {
        if (!v.videoWidth) return finish(null);
        drawToBlob(v, v.videoWidth, v.videoHeight, 480, 0.7).then(finish, () => finish(null));
      };
      v.onerror = () => finish(null);
      v.src = src;
      v.load();
    });
  }

  async function addFile(file) {
    const type = guessType(file);
    const kind = type.startsWith('image/') ? 'photo' : type.startsWith('video/') ? 'video' : null;
    if (!kind) return toast(`"${file.name}" isn't a photo or video.`);
    if (kind === 'video' && file.size > MAX_BYTES) return toast('That video is too large. Try a clip under 45 seconds.');

    preparing++;
    renderStatus();
    try {
      const p = kind === 'photo' ? await preparePhoto(file, type) : await prepareVideo(file);
      const item = {
        id: uuid(), slug, kind,
        blob: p.blob, type: p.blob.type || p.type || type, thumb: p.thumb,
        w: p.w, h: p.h, tries: 0, added: Date.now(),
      };
      if (item.blob.size > MAX_BYTES) return toast('That file is too large to share.');
      await qPut(item);
      queue.push(item);
    } catch (err) {
      console.error(err);
      toast('Could not read that file. Please try another.');
    } finally {
      preparing--;
      renderStatus();
      pump();
    }
  }

  // ---------- upload queue (IndexedDB, survives reloads) ----------
  let queue = [];
  let preparing = 0;
  let busy = false;
  let progress = 0;
  let waitingUntil = 0;
  let wakeTimer;
  let sharedThisVisit = 0;

  const dbp = new Promise((res, rej) => {
    if (!('indexedDB' in window)) return res(null);
    const r = indexedDB.open('guest-album', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('queue', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => res(null); // private mode etc.: queue lives in memory only
  });
  async function tx(mode, fn) {
    const db = await dbp;
    if (!db) return undefined;
    return new Promise((res, rej) => {
      const t = db.transaction('queue', mode);
      const out = fn(t.objectStore('queue'));
      t.oncomplete = () => res(out && out.result);
      t.onerror = () => rej(t.error);
    });
  }
  const qPut = (item) => tx('readwrite', (s) => s.put(item)).catch(() => {});
  const qDel = (id) => tx('readwrite', (s) => s.delete(id)).catch(() => {});
  const qAll = () => tx('readonly', (s) => s.getAll()).catch(() => []);

  async function resumeQueue() {
    const saved = (await qAll()) || [];
    const known = new Set(queue.map((q) => q.id));
    saved.filter((q) => q.slug === slug && !known.has(q.id)).forEach((q) => queue.push(q));
    queue.sort((a, b) => a.added - b.added);
    renderStatus();
    pump();
  }

  function put(url, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      let last = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - last > STALL_MS) { clearInterval(watchdog); x.abort(); reject(new Error('stalled')); }
      }, 5000);
      x.open('PUT', url);
      x.setRequestHeader('X-Guest-Token', state.token);
      x.setRequestHeader('Content-Type', blob.type || 'application/octet-stream');
      x.upload.onprogress = (e) => { last = Date.now(); if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      x.onload = () => {
        clearInterval(watchdog);
        let data = {};
        try { data = JSON.parse(x.responseText); } catch {}
        resolve({ status: x.status, data });
      };
      x.onerror = () => { clearInterval(watchdog); reject(new Error('network')); };
      x.onabort = () => { clearInterval(watchdog); reject(new Error('aborted')); };
      x.send(blob);
    });
  }

  async function uploadOne(item) {
    if (item.kind === 'wish-text' || item.kind === 'wish-voice') {
      const body = item.blob.type ? item.blob : new Blob([item.blob], { type: item.type });
      return put(`${API}/wishes/${item.id}?guest=${encodeURIComponent(state.guestId)}`, body, (p) => { progress = p; renderStatus(); });
    }
    const blob = item.blob.type ? item.blob : new Blob([item.blob], { type: item.type });
    if (item.thumb) {
      const t = await put(`${API}/thumbs/${item.id}`, item.thumb);
      if (t.status >= 500) throw new Error('server');
      if (t.status >= 400 && t.status !== 413) return t; // let the media call report the real problem
    }
    const q = new URLSearchParams({ guest: state.guestId });
    if (item.w) q.set('w', item.w);
    if (item.h) q.set('h', item.h);
    return put(`${API}/media/${item.id}?${q}`, blob, (p) => { progress = p; renderStatus(); });
  }

  async function pump() {
    if (busy || !queue.length || !state.guestId) return;
    if (Date.now() < waitingUntil) return;
    busy = true;
    const item = queue[0];
    progress = 0;
    renderStatus();
    try {
      const res = await uploadOne(item);
      if (res.status < 300) {
        await done(item, true);
      } else if (res.data.code === 'no_guest') {
        await join(state.name); // device forgot by the server: re-register and retry
      } else if (res.data.code === 'bad_token' || res.data.code === 'closed') {
        queue = []; // nothing more can be sent
        toast(res.data.error);
      } else if (res.status >= 400 && res.status < 500) {
        await done(item, false);
        toast(res.data.error || 'That file could not be shared.');
      } else {
        throw new Error('server');
      }
      item.tries = 0;
      waitingUntil = 0;
    } catch {
      // No signal, timeout or server hiccup: wait and try again, longer each time
      item.tries = (item.tries || 0) + 1;
      const wait = Math.min(30000, 2000 * 2 ** Math.min(item.tries - 1, 4));
      waitingUntil = Date.now() + wait;
      clearTimeout(wakeTimer);
      wakeTimer = setTimeout(() => { waitingUntil = 0; pump(); }, wait);
    } finally {
      busy = false;
      renderStatus();
      if (!waitingUntil) setTimeout(pump, 0);
    }
  }

  async function done(item, ok) {
    queue = queue.filter((q) => q.id !== item.id);
    await qDel(item.id);
    if (ok && item.kind.startsWith('wish')) {
      state.wishCount = (state.wishCount || 0) + 1;
      saveState();
      toast('Your wish has been sent to the couple.');
      return;
    }
    if (ok) {
      sharedThisVisit++;
      state.sharedCount = (state.sharedCount || 0) + 1;
      saveState();
      pollFeed();
    }
  }

  // Signal back, or the guest returns to the page: try straight away
  const wake = () => { waitingUntil = 0; clearTimeout(wakeTimer); pump(); };
  window.addEventListener('online', wake);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { wake(); pollFeed(); } });

  function renderStatus() {
    const box = $('status');
    const pending = queue.length;
    if (!pending && !preparing) {
      if (sharedThisVisit) {
        box.className = 'status done';
        $('status-main').textContent = `Shared, thank you!`;
        $('status-sub').textContent = `${state.sharedCount} from you so far`;
        $('status-bar').style.width = '100%';
      } else {
        show(box, false);
      }
      return;
    }
    show(box);
    if (preparing && !pending) {
      box.className = 'status';
      $('status-main').textContent = 'Getting your photos ready…';
      $('status-sub').textContent = '';
      $('status-bar').style.width = '0%';
    } else if (waitingUntil && !busy) {
      box.className = 'status waiting';
      $('status-main').textContent = navigator.onLine === false ? 'No signal right now' : 'Connection is weak';
      $('status-sub').textContent = `${pending} waiting, will send when the signal is back`;
      $('status-bar').style.width = '0%';
    } else {
      box.className = 'status';
      const pct = Math.round(progress * 100);
      $('status-main').textContent = pending === 1 ? `Sharing… ${pct}%` : `Sharing 1 of ${pending}… ${pct}%`;
      $('status-sub').textContent = 'Keep this page open until it finishes';
      $('status-bar').style.width = `${pct}%`;
    }
  }

  // ---------- wishes ----------
  const wishMsg = (text, cls = 'ok') => { $('wish-msg').className = `msg ${cls}`; $('wish-msg').textContent = text; };

  document.querySelectorAll('.seg-btn').forEach((b) => (b.onclick = () => {
    document.querySelectorAll('.seg-btn').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-selected', x === b); });
    show($('tab-write'), b.dataset.tab === 'write');
    show($('tab-record'), b.dataset.tab === 'record');
    wishMsg('', '');
  }));
  const canRecord = !!(window.MediaRecorder && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  if (!canRecord) show($('seg-record'), false);

  async function queueWish(kind, blob) {
    const item = { id: uuid(), slug, kind, blob, type: blob.type, thumb: null, w: null, h: null, tries: 0, added: Date.now() };
    await qPut(item);
    queue.push(item);
    renderStatus();
    pump();
  }

  $('wish-send-text').onclick = async () => {
    const body = $('wish-text').value.trim();
    if (!body) { wishMsg('Write a few words first.', 'err'); $('wish-text').focus(); return; }
    await queueWish('wish-text', new Blob([JSON.stringify({ body })], { type: 'application/json' }));
    $('wish-text').value = '';
    wishMsg('Thank you! Your wish is on its way to the couple.');
  };

  // Chrome's own voice recordings carry no length, so players show 0:00. Seeking to the end makes the browser work it out.
  function fixAudioDuration(audio) {
    audio.addEventListener('loadedmetadata', function once() {
      if (audio.duration === Infinity || isNaN(audio.duration)) {
        audio.currentTime = 1e101;
        audio.addEventListener('timeupdate', function reset() {
          audio.removeEventListener('timeupdate', reset);
          audio.currentTime = 0;
        });
      }
      audio.removeEventListener('loadedmetadata', once);
    });
  }
  fixAudioDuration($('rec-audio'));

  const MAX_REC_MS = 60000;
  let recorder = null, recBlob = null, recStart = 0, recTick = null;
  function pickAudioType() {
    for (const t of ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm']) {
      if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) return t;
    }
    return '';
  }
  const mmss = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

  async function startRecording() {
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { wishMsg('Allow microphone access to record, or write your wish instead.', 'err'); return; }
    const type = pickAudioType();
    const chunks = [];
    recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 64000 } : undefined);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(recTick);
      const mime = (recorder.mimeType || type || 'audio/webm').split(';')[0];
      recBlob = new Blob(chunks, { type: mime });
      recorder = null;
      $('rec-btn').classList.remove('live');
      $('rec-label').textContent = 'Tap to record';
      if (!recBlob.size) { wishMsg('Nothing was recorded. Please try again.', 'err'); return; }
      $('rec-audio').src = URL.createObjectURL(recBlob);
      show($('rec-btn'), false); show($('rec-hint'), false); show($('rec-review'));
    };
    recorder.start(1000);
    recStart = Date.now();
    $('rec-btn').classList.add('live');
    wishMsg('', '');
    const tick = () => {
      const t = Date.now() - recStart;
      $('rec-label').textContent = `Recording ${mmss(t)}, tap to stop`;
      if (t >= MAX_REC_MS && recorder) recorder.stop();
    };
    tick();
    recTick = setInterval(tick, 250);
  }

  $('rec-btn').onclick = () => { if (recorder) recorder.stop(); else startRecording(); };
  function resetRecording() {
    recBlob = null;
    $('rec-audio').removeAttribute('src');
    show($('rec-review'), false); show($('rec-btn')); show($('rec-hint'));
  }
  $('rec-again').onclick = () => { resetRecording(); startRecording(); };
  $('wish-send-voice').onclick = async () => {
    if (!recBlob) return;
    await queueWish('wish-voice', recBlob);
    resetRecording();
    wishMsg('Thank you! Your voice wish is on its way to the couple.');
  };

  // ---------- gallery ----------
  const items = new Map(); // id -> item
  let order = [];          // ids, newest first
  let newest = null, oldest = null, pollTimer, polling = false;

  let ownOnly = false;
  function applyPrivacy(data) {
    ownOnly = data.privacy === 'private' && !data.couple_view;
    const note = $('privacy-note');
    if (data.couple_view) {
      $('gallery-title').textContent = "All guests' photos";
      note.textContent = data.privacy === 'private'
        ? 'Guests only see their own photos. You two see everything.'
        : 'You are viewing as the couple.';
    } else if (ownOnly) {
      $('gallery-title').textContent = 'Your photos';
      note.textContent = 'Only you and the couple can see the photos you share.';
      $('empty').textContent = 'Photos you share will appear here.';
    }
    show(note, !!(data.couple_view || ownOnly));
  }

  async function loadGallery() {
    try {
      const data = await api('/feed');
      applyPrivacy(data);
      merge(data.items);
      show($('more'), data.has_more);
      setCount(data.total);
    } catch (err) {
      if (err.code === 'bad_token') return problem('This link has expired. Please scan the QR code on your table again.');
    }
    render();
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!document.hidden && Date.now() - lastActive < IDLE_MS) pollFeed();
    }, POLL_MS);
  }

  // A phone left open on a table shouldn't keep checking all afternoon
  let lastActive = Date.now();
  const wasIdle = () => Date.now() - lastActive >= IDLE_MS;
  ['pointerdown', 'scroll', 'keydown'].forEach((t) => window.addEventListener(t, () => {
    const idle = wasIdle();
    lastActive = Date.now();
    if (idle) pollFeed(); // catch up straight away when someone picks the phone back up
  }, { passive: true }));

  async function pollFeed() {
    if (polling || !state.guestId) return;
    polling = true;
    try {
      const data = await api(`/feed${newest ? `?since=${encodeURIComponent(newest)}` : ''}`);
      const added = merge(data.items);
      if (added) render();
      if (data.total != null) setCount(data.total);
      else if (added) setCount(total + added);
    } catch {} finally { polling = false; }
  }

  $('more').onclick = async () => {
    $('more').disabled = true;
    try {
      const data = await api(`/feed?before=${encodeURIComponent(oldest)}`);
      merge(data.items);
      show($('more'), data.has_more);
      render();
    } catch { toast('Could not load more. Check your signal.'); }
    $('more').disabled = false;
  };

  function merge(list) {
    let added = 0;
    for (const it of list) {
      if (items.has(it.id)) continue;
      items.set(it.id, it);
      added++;
      if (!newest || it.created_at > newest) newest = it.created_at;
      if (!oldest || it.created_at < oldest) oldest = it.created_at;
    }
    if (added) order = [...items.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)).map((i) => i.id);
    return added;
  }

  let total = 0;
  function setCount(n) {
    total = n || 0;
    $('count').textContent = total ? `${total} shared${ownOnly ? ' by you' : ''}` : '';
  }

  function render() {
    const grid = $('grid');
    show($('empty'), order.length === 0);
    // Add tiles that aren't on the page yet, keeping newest first
    const existing = new Set([...grid.children].map((c) => c.dataset.id));
    let prevEl = null;
    order.forEach((id) => {
      let el = existing.has(id) ? grid.querySelector(`[data-id="${id}"]`) : null;
      if (!el) {
        el = tile(items.get(id));
        if (prevEl) prevEl.after(el); else grid.prepend(el);
      }
      prevEl = el;
    });
  }

  function tile(it) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `tile ${it.kind}`;
    b.dataset.id = it.id;
    b.setAttribute('aria-label', `${it.kind === 'video' ? 'Video' : 'Photo'} shared by ${it.guest_name}`);
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = '';
    img.src = it.thumb_url;
    img.onerror = () => {
      img.onerror = null;
      if (it.kind === 'photo') img.src = it.url; // no preview made: use the photo itself
      else img.remove();                         // video without preview: plain tile with play badge
    };
    b.append(img);
    if (it.kind === 'video') b.insertAdjacentHTML('beforeend', '<span class="play" aria-hidden="true"></span>');
    b.onclick = () => openViewer(it.id);
    return b;
  }

  // ---------- viewer ----------
  let current = null;
  function openViewer(id) {
    current = id;
    show($('viewer'));
    document.body.style.overflow = 'hidden';
    paintViewer();
  }
  function closeViewer() {
    show($('viewer'), false);
    $('v-stage').innerHTML = '';
    document.body.style.overflow = '';
    current = null;
  }
  function step(dir) {
    const i = order.indexOf(current) + dir;
    if (i >= 0 && i < order.length) { current = order[i]; paintViewer(); }
  }
  function paintViewer() {
    const it = items.get(current);
    const stage = $('v-stage');
    stage.innerHTML = '';
    let media;
    if (it.kind === 'video') {
      media = document.createElement('video');
      media.controls = true; media.playsInline = true; media.autoplay = true;
      media.poster = it.thumb_url;
    } else {
      media = document.createElement('img');
      media.alt = `Photo shared by ${it.guest_name}`;
    }
    media.src = it.url;
    stage.append(media);
    const cap = $('v-caption'), who = document.createElement('b');
    who.textContent = it.guest_name;
    cap.replaceChildren('Shared by ', who);
    const i = order.indexOf(current);
    $('v-prev').disabled = i <= 0;
    $('v-next').disabled = i >= order.length - 1;
    disarmDelete();
    show($('v-delete'), !!it.can_delete);
  }

  // Delete: first tap arms the button, second tap within 4 s deletes
  let deleteArmed = null;
  function disarmDelete() {
    clearTimeout(deleteArmed); deleteArmed = null;
    $('v-delete').classList.remove('armed');
    $('v-delete-label').textContent = 'Delete';
  }
  $('v-delete').onclick = async () => {
    if (!deleteArmed) {
      $('v-delete').classList.add('armed');
      $('v-delete-label').textContent = 'Tap again to delete';
      deleteArmed = setTimeout(disarmDelete, 4000);
      return;
    }
    const id = current;
    disarmDelete();
    $('v-delete').disabled = true;
    try {
      await api(`/media/${id}`, { method: 'DELETE' });
      removeItem(id);
      toast('Deleted.');
    } catch (err) {
      toast(err.status ? err.message : 'Deleting needs a connection. Try again when you have signal.');
    } finally {
      $('v-delete').disabled = false;
    }
  };

  function removeItem(id) {
    const i = order.indexOf(id);
    items.delete(id);
    order = order.filter((x) => x !== id);
    const tileEl = $('grid').querySelector(`[data-id="${id}"]`);
    if (tileEl) tileEl.remove();
    setCount(Math.max(0, total - 1));
    show($('empty'), order.length === 0);
    if (current === id) {
      if (!order.length) closeViewer();
      else { current = order[Math.min(i, order.length - 1)]; paintViewer(); }
    }
  }
  $('v-close').onclick = closeViewer;
  $('v-prev').onclick = () => step(-1);
  $('v-next').onclick = () => step(1);
  $('viewer').addEventListener('click', (e) => { if (e.target.id === 'viewer' || e.target.id === 'v-stage') closeViewer(); });
  document.addEventListener('keydown', (e) => {
    if (current === null) return;
    if (e.key === 'Escape') closeViewer();
    if (e.key === 'ArrowLeft') step(-1);
    if (e.key === 'ArrowRight') step(1);
  });
  let touchX = null;
  $('viewer').addEventListener('touchstart', (e) => { touchX = e.touches[0].clientX; }, { passive: true });
  $('viewer').addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
    touchX = null;
  });

  start();
})();
