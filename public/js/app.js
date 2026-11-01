/* Estación Puma — interfaz */
(() => {
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const S = { me: null, data: null, events: [], notes: [], voice: true, group: false, open: null, timer: null, lastBrief: '', view: 'panel', termStarted: false, people: [], mailWith: '', unread: 0, unreadFrom: {} };
  const TITLES = { panel: 'PANEL', log: 'REGISTRO', access: 'ACCESOS', profile: 'MI PERFIL' };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const bytes = (n) => { if (n == null) return '–'; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return (n >= 100 || i === 0 ? n.toFixed(0) : n.toFixed(1)) + ' ' + u[i]; };
  const rate = (n) => bytes(n || 0) + '/s';
  const pct = (n) => (n == null ? '–' : (n >= 10 ? n.toFixed(0) : n.toFixed(1)) + '%');
  const ago = (ts) => { const d = Math.max(0, Date.now() / 1000 - ts); return d < 90 ? 'ahora' : d < 5400 ? Math.round(d / 60) + ' min' : d < 129600 ? Math.round(d / 3600) + ' h' : Math.round(d / 86400) + ' d'; };
  const isAdmin = () => S.me && (S.me.role === 'admin' || S.me.role === 'superadmin');
  const isSuper = () => S.me?.role === 'superadmin';
  const ROLE = { superadmin: 'Superadmin', admin: 'Admin', viewer: 'Solo lectura' };

  async function api(url, opt = {}) {
    const init = { ...opt };
    if (opt.body !== undefined) { init.headers = { 'content-type': 'application/json' }; init.body = JSON.stringify(opt.body); }
    const r = await fetch(url, init);
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json().catch(() => ({})) : await r.text();
    if (!r.ok) { const e = new Error((data && data.error) || (typeof data === 'string' && data) || r.status); e.status = r.status; e.code = data && data.error; throw e; }
    return data;
  }

  function setAvatar(el, u) {
    if (u.photo) { el.style.backgroundImage = `url(${u.photo})`; el.textContent = ''; }
    else { el.style.backgroundImage = ''; el.textContent = (u.name || u.email || '?').trim().slice(0, 1).toUpperCase(); }
  }

  /* ---------- Voz ---------- */
  const eye = $('porthole');
  const setEye = (st) => { eye.dataset.state = st; };
  /* Cara de Puma: expresión, parpadeo y mandíbula que acompaña a la voz */
  const head = $('head');
  const setMood = (m) => { eye.dataset.mood = m; };
  const moodFor = (t) => (/atenci[oó]n|no est[aá] (corriendo|en l[ií]nea)|sin respuesta|ca[ií]d[oa]|fall[oa]|error|peligro|vencer|intentos fallidos/i.test(t) ? 'serious'
    : /perfecto|listo|todo en orden|en l[ií]nea|enviado|anotado|reinici|hola|buen[oa]s|gracias|hasta pronto/i.test(t) ? 'happy' : 'calm');
  S.idleMood = 'calm';
  const idleMood = () => S.idleMood;
  let talk = null;
  function startTalk(level) {
    stopTalk(); let amp = 1, cur = 0, last = performance.now(); const t0 = last;
    talk = { raf: 0, seen: false, bound: 0, bump() { this.seen = true; this.bound = performance.now(); amp = 1; } };
    const frame = (t) => {
      if (level) { // voz neuronal: la mandíbula sigue el volumen real del audio
        cur += (Math.min(1, level() * 3.2) - cur) * 0.55;
        head.style.setProperty('--jaw', cur.toFixed(3));
        talk.raf = requestAnimationFrame(frame); return;
      }
      const x = (t - t0) / 1000;
      let base = Math.max(0, Math.sin(x * 2 * Math.PI * 5.4 + Math.sin(x * 2.3) * 2.2)) * (0.55 + 0.45 * Math.abs(Math.sin(x * 1.7)));
      if (talk.seen && t - talk.bound > 420) base *= 0.12; // pausa entre frases
      cur += (base * amp - cur) * 0.5; amp = Math.max(0.6, amp - 0.015);
      head.style.setProperty('--jaw', cur.toFixed(3));
      talk.raf = requestAnimationFrame(frame);
    };
    talk.raf = requestAnimationFrame(frame);
  }
  function stopTalk() { if (talk) { cancelAnimationFrame(talk.raf); talk = null; } head.style.setProperty('--jaw', 0); }
  (function blinkLoop() { setTimeout(() => { head.classList.add('blink'); setTimeout(() => head.classList.remove('blink'), 140); blinkLoop(); }, 2800 + Math.random() * 3600); })();
  let voiceEs = null;
  const pickVoice = () => { const v = speechSynthesis.getVoices(); voiceEs = v.find((x) => /es-AR/i.test(x.lang)) || v.find((x) => /es-(MX|US|419)/i.test(x.lang)) || v.find((x) => /^es/i.test(x.lang)) || null; };
  if ('speechSynthesis' in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  // Voz neuronal (OpenAI) con respaldo a la voz del navegador.
  const V = { el: new Audio(), ctx: null, an: null, buf: null, ready: false, token: 0, finish: null };
  V.el.preload = 'auto'; V.el.playsInline = true;
  const SILENCIO = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
  // iOS/Safari solo deja reproducir audio si antes hubo un toque: se "desbloquea" una vez con el primer toque.
  function unlockAudio() {
    if (V.ready) return; V.ready = true;
    try { V.el.src = SILENCIO; V.el.play().then(() => V.el.pause()).catch(() => {}); } catch {}
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) { V.ctx = new AC(); V.ctx.resume?.().then(() => {
        if (V.ctx.state !== 'running' || V.an) return;
        V.an = V.ctx.createAnalyser(); V.an.fftSize = 512; V.buf = new Uint8Array(V.an.fftSize);
        V.ctx.createMediaElementSource(V.el).connect(V.an); V.an.connect(V.ctx.destination);
      }).catch(() => {}); }
    } catch {}
  }
  ['pointerdown', 'keydown', 'touchend'].forEach((ev) => addEventListener(ev, unlockAudio, { once: true, passive: true }));
  const audioLevel = () => { // volumen del audio (0..1), medido sobre la onda
    V.an.getByteTimeDomainData(V.buf); let sum = 0;
    for (let i = 0; i < V.buf.length; i++) { const d = (V.buf[i] - 128) / 128; sum += d * d; }
    return Math.sqrt(sum / V.buf.length);
  };
  function stopSpeech() {
    V.token++; try { V.el.pause(); } catch {}
    if (V.finish) { const f = V.finish; V.finish = null; f(); }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
  }
  async function speakNeural(text) {
    const my = ++V.token;
    let res; try { res = await fetch('/api/voice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) }); } catch { return false; }
    if (res.status === 204) S.neuralOff = Date.now() + 10 * 60e3; // sin voz neuronal (tope diario o sin clave): no insistir 10 min
    if (res.status !== 200 || my !== V.token) return my !== V.token;
    if (V.an && V.ctx.state !== 'running') { try { await V.ctx.resume(); } catch {} if (V.ctx.state !== 'running') return false; } // audio en pausa por el sistema: usar la voz del navegador
    const url = URL.createObjectURL(await res.blob());
    if (my !== V.token) { URL.revokeObjectURL(url); return true; }
    return new Promise((ok) => {
      let done = false;
      const end = (played) => { if (done) return; done = true; V.finish = null; V.el.onended = V.el.onerror = null; URL.revokeObjectURL(url); stopTalk(); setEye('idle'); setMood(idleMood()); ok(played); };
      V.finish = () => end(true);
      V.el.onended = () => end(true);
      V.el.onerror = () => end(false);
      V.el.src = url;
      V.el.play().then(() => { setEye('speaking'); setMood(moodFor(text)); if (V.ctx?.state === 'suspended') V.ctx.resume?.(); startTalk(V.an && V.ctx?.state === 'running' ? audioLevel : null); }).catch(() => end(false));
    });
  }
  function speakBrowser(text) {
    if (!('speechSynthesis' in window)) return Promise.resolve();
    return new Promise((ok) => {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = voiceEs?.lang || 'es-AR'; if (voiceEs) u.voice = voiceEs; u.rate = 1.02;
      u.onstart = () => { setEye('speaking'); setMood(moodFor(text)); startTalk(); };
      u.onboundary = () => talk?.bump();
      u.onend = u.onerror = () => { stopTalk(); setEye('idle'); setMood(idleMood()); ok(); };
      speechSynthesis.speak(u);
    });
  }
  async function speak(text, quiet = false) {
    if (!quiet) $('say').textContent = text;
    if (!S.voice) return;
    stopSpeech();
    if (Date.now() > (S.neuralOff || 0)) {
      const played = await speakNeural(text);
      if (played) return;
    }
    return speakBrowser(text);
  }
  function listen(onText, onEnd) {
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!R) { onEnd(false); return null; }
    const r = new R(); r.lang = 'es-AR'; r.interimResults = true; r.continuous = false;
    setEye('listening');
    r.onresult = (e) => onText([...e.results].map((x) => x[0].transcript).join(' '));
    r.onend = () => { setEye('idle'); onEnd(true); };
    r.onerror = () => { setEye('idle'); onEnd(true); };
    r.start();
    return r;
  }

  /* ---------- Diales redondos ---------- */
  const R1 = 25, R2 = 18.5;
  const arcLen = (r) => 2 * Math.PI * r;
  const sq = (v) => 100 * Math.sqrt(Math.max(0, Math.min(100, v)) / 100); // escala que hace visibles los valores bajos
  function arc(r, v, col, w, glow = true) {
    const C = arcLen(r), a = C * 0.75;
    return `<circle cx="50" cy="50" r="${r}" fill="none" stroke="rgba(56,232,255,.12)" stroke-width="${w}" stroke-dasharray="${a} ${C}" transform="rotate(135 50 50)" stroke-linecap="round"/>
      <circle cx="50" cy="50" r="${r}" fill="none" stroke="${col}" stroke-width="${w}" stroke-dasharray="${(a * v) / 100} ${C}" transform="rotate(135 50 50)" stroke-linecap="round" style="${glow ? `filter:drop-shadow(0 0 2.5px ${col});` : ''}transition:stroke-dasharray .8s"/>`;
  }
  const level = (v, base) => (v > 90 ? 'var(--bad)' : v > 75 ? 'var(--warn)' : base);

  // Dial simple (indicadores del servidor)
  function gauge(label, value, center, sub, base = 'var(--cyan)') {
    const w = document.createElement('div'); w.className = 'gcell';
    const v = Math.max(0, Math.min(100, value || 0));
    w.innerHTML = `<div class="gauge"><svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="30" fill="rgba(2,8,12,.92)"/>${arc(R1 - 1, v, level(v, base), 5)}
      <text x="50" y="54" text-anchor="middle" fill="#dff7ff" font-family="Share Tech Mono, monospace" font-size="13">${esc(center)}</text></svg><img class="ring" src="/assets/gauge-ring.webp" alt=""></div>
      <div class="g-plate"><div class="g-cap">${esc(label)}</div><div class="g-sub" title="${esc(sub || '')}">${esc(sub || '')}</div></div>`;
    return w;
  }

  // Dial de proyecto: arco externo CPU, interno memoria
  function projectDial(r, rank) {
    const host = S.data.host;
    const memPct = host ? (r.mem / host.memTotal) * 100 : 0;
    const cpuV = sq(r.cpu), memV = sq(memPct * 3);
    const idle = idleAux(r);
    const led = idle ? 'idle' : r.status === 'exited' ? 'bad' : r.status === 'degraded' || r.online === false || r.healthy === false ? 'warn' : '';
    const site = (r.sites || [])[0];
    const el = document.createElement('div');
    el.className = 'dial' + (led ? ' ' + led : ''); el.tabIndex = 0; el.setAttribute('role', 'button');
    el.title = `${r.name}\nCPU ${pct(r.cpu)} · RAM ${bytes(r.mem)} (${pct(memPct)} del servidor)`;
    const badge = rank && rank <= 3 && r.cpu > 0.3 ? `<span class="chip top${rank}">#${rank}</span>` : '';
    const kind = { base: 'DB', sistema: 'SYS' }[r.kind] || '';
    const stateTxt = idle ? '<span class="mute">auxiliar · inactivo</span>' : r.status === 'exited' ? '<span class="bad">detenido</span>' : r.status === 'degraded' ? '<span class="warn">parcial</span>' : site ? `<span class="${site.ok ? 'ok' : 'bad'}">${site.ok ? 'en línea' : 'sin respuesta'}${site.ms != null ? ' · ' + site.ms + ' ms' : ''}</span>` : '<span class="ok">corriendo</span>';
    const up = site?.up24 != null ? `${site.up24.toFixed(site.up24 >= 99.95 ? 0 : 1)}% 24h` : '';
    el.innerHTML = `<div class="gauge"><svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="30" fill="rgba(2,8,12,.92)"/>
      ${arc(R1, cpuV, level(cpuV, 'var(--cyan)'), 3.6)}${arc(R2, memV, 'var(--brass)', 3.6)}
      <text x="50" y="50" text-anchor="middle" fill="#dff7ff" font-family="Share Tech Mono, monospace" font-size="11.5">${pct(r.cpu)}</text>
      <text x="50" y="59.5" text-anchor="middle" fill="#c9964a" font-family="Share Tech Mono, monospace" font-size="6.2">${bytes(r.mem)}</text></svg><img class="ring" src="/assets/gauge-ring.webp" alt=""></div>
      <div class="d-name"><span class="led ${led}"></span><span class="t" title="${esc(r.name)}">${esc(r.name)}</span>${badge}${kind ? `<span class="chip">${kind}</span>` : ''}</div>
      <div class="d-line">${stateTxt}${up ? ' · ' + up : ''}</div>
      <div class="d-line">↓ ${rate(r.rx)} · ↑ ${rate(r.tx)}${site?.certDays != null && site.certDays < 21 ? ` · <span class="warn">cert ${site.certDays} d</span>` : ''}</div>`;
    const open = () => openDrawer(r.name);
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    return el;
  }

  function renderSides() {
    const h = S.data?.host; if (!h) return;
    const ram = (h.memUsed / h.memTotal) * 100, disk = h.diskTotal ? (h.diskUsed / h.diskTotal) * 100 : 0;
    const apps = (S.data.resources || []).filter((r) => r.kind !== 'sistema');
    const onl = apps.filter((r) => r.status === 'running' && r.online !== false).length;
    const cts = (S.data.resources || []).flatMap((r) => r.containers);
    const run = cts.filter((c) => c.state === 'running').length;
    const loadPct = Math.min(100, (h.load[0] / h.cores) * 100);
    $('side-l').replaceChildren(
      gauge('CPU', h.cpu, Math.round(h.cpu) + '%', `${h.cores} núcleos`),
      gauge('MEMORIA', ram, Math.round(ram) + '%', `${bytes(h.memUsed)} / ${bytes(h.memTotal)}`),
      gauge('DISCO', disk, Math.round(disk) + '%', `${bytes(h.diskUsed)} / ${bytes(h.diskTotal)}`, 'var(--brass)'));
    const up = h.uptime / 86400;
    $('side-r').replaceChildren(
      gauge('CARGA', loadPct, h.load[0].toFixed(2), `${h.load.map((x) => x.toFixed(1)).join(' · ')}`),
      gauge('EN LÍNEA', apps.length ? (onl / apps.length) * 100 : 0, `${onl}/${apps.length}`, 'proyectos', 'var(--ok)'),
      gauge('CONTENEDORES', cts.length ? (run / cts.length) * 100 : 0, `${run}/${cts.length}`, `encendido ${up >= 1 ? Math.floor(up) + ' d' : Math.floor(h.uptime / 3600) + ' h'} · ${S.data.docker.ok ? 'Docker ok' : 'Docker sin conexión'}`, 'var(--ok)'));
  }

  /* ---------- Gráficos ---------- */
  function chartSvg(rows, key, fmt, color) {
    const el = document.createElementNS(NS, 'svg'); el.setAttribute('viewBox', '0 0 600 120'); el.classList.add('chart'); el.setAttribute('preserveAspectRatio', 'none');
    const v = rows.map((r) => r[key] || 0);
    if (v.length < 2) { el.innerHTML = '<text x="300" y="64" text-anchor="middle" fill="#86a9b6" font-size="13">Reuniendo datos…</text>'; return el; }
    const max = Math.max(1e-9, ...v) * 1.1, step = 600 / (v.length - 1);
    const pts = v.map((x, i) => `${(i * step).toFixed(1)},${(112 - (x / max) * 104).toFixed(1)}`);
    el.innerHTML = `<polyline points="0,120 ${pts.join(' ')} 600,120" fill="${color}22"/><polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/><text x="6" y="14" fill="#86a9b6" font-size="11" font-family="monospace">máx ${fmt(max / 1.1)}</text>`;
    return el;
  }

  /* ---------- Proyectos ---------- */
  const score = (r) => r.cpu + (S.data.host ? (r.mem / S.data.host.memTotal) * 100 : 0) * 0.6;
  const idleAux = (r) => r.kind === 'sistema' && r.status === 'exited'; // contenedor auxiliar apagado (p. ej. el de compilación de Coolify): es normal
  const problems = (r) => (idleAux(r) ? 0 : r.status !== 'running' ? 2 : r.online === false || r.healthy === false ? 1 : 0);
  function visible() {
    let list = (S.data?.resources || []).slice();
    const k = $('f-kind').value, q = $('q').value.trim().toLowerCase();
    if (k !== 'todo') list = list.filter((r) => r.kind === k);
    if (q) list = list.filter((r) => (r.name + ' ' + (r.hosts || []).join(' ') + ' ' + r.family).toLowerCase().includes(q));
    const cmp = { consumo: (a, b) => score(b) - score(a), cpu: (a, b) => b.cpu - a.cpu, ram: (a, b) => b.mem - a.mem, red: (a, b) => b.rx + b.tx - (a.rx + a.tx), estado: (a, b) => problems(b) - problems(a) || score(b) - score(a), nombre: (a, b) => a.name.localeCompare(b.name) }[$('f-sort').value];
    return list.sort(cmp);
  }
  // Tuberías de latón detrás de cada fila de relojes
  function drawRails(box) {
    box.querySelectorAll(':scope > .rail').forEach((n) => n.remove());
    const dials = [...box.querySelectorAll(':scope > .dial')];
    if (!dials.length || !box.offsetParent) return;
    const rows = new Map();
    dials.forEach((d, i) => { d.style.setProperty('--i', i); if (!rows.has(d.offsetTop)) rows.set(d.offsetTop, d.querySelector('.gauge')?.offsetHeight || 190); });
    for (const [top, gh] of rows) { const el = document.createElement('div'); el.className = 'rail'; el.style.top = (top + 4 + gh / 2 - 6) + 'px'; box.prepend(el); }
  }
  new ResizeObserver(() => { clearTimeout(drawRails.t); drawRails.t = setTimeout(() => { drawRails($('cards')); drawRails($('sites-grid')); }, 120); }).observe(document.body);
  function renderCards() {
    if (!S.data) return;
    const list = visible();
    const apps = (S.data.resources || []).filter((r) => r.kind === 'app').sort((a, b) => b.cpu - a.cpu);
    const rankOf = (r) => (r.kind === 'app' ? apps.indexOf(r) + 1 : 0);
    const box = $('cards'); box.replaceChildren();
    requestAnimationFrame(() => drawRails(box));
    if (!list.length) { box.innerHTML = S.data.docker.ok ? '<p class="empty">Sin proyectos para mostrar.</p>' : `<p class="empty">Sin conexión con Docker: ${esc(S.data.docker.error)}</p>`; return; }
    if (!S.group) { list.forEach((r) => box.append(projectDial(r, rankOf(r)))); return; }
    const fam = new Map();
    list.forEach((r) => { const k = r.family || r.name; (fam.get(k) || fam.set(k, []).get(k)).push(r); });
    for (const [k, items] of fam) { const h = document.createElement('h2'); h.textContent = k; box.append(h); items.forEach((r) => box.append(projectDial(r, rankOf(r)))); }
  }

  function siteDial(t) {
    const el = document.createElement('div');
    const up = t.up24 != null ? t.up24 : (t.ok ? 100 : 0);
    const col = t.ok === false ? 'var(--bad)' : up < 99 ? 'var(--warn)' : 'var(--ok)';
    const led = t.ok === false ? 'bad' : t.ok == null ? 'warn' : '';
    el.className = 'dial' + (led ? ' ' + led : '');
    el.title = `${t.url}\nHTTP ${t.status ?? '–'} · promedio ${t.avgMs ?? '–'} ms`;
    el.innerHTML = `<div class="gauge"><svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="30" fill="rgba(2,8,12,.92)"/>${arc(R1, t.ok == null ? 0 : up, col, 3.6)}
      <text x="50" y="50" text-anchor="middle" fill="#dff7ff" font-family="Share Tech Mono, monospace" font-size="${t.ms != null ? 11.5 : 9}">${t.ms != null ? t.ms + ' ms' : '…'}</text>
      <text x="50" y="59.5" text-anchor="middle" fill="${col}" font-family="Share Tech Mono, monospace" font-size="6.2">${t.ok === false ? 'SIN RESPUESTA' : t.up24 != null ? t.up24.toFixed(1) + '% 24h' : 'midiendo'}</text></svg><img class="ring" src="/assets/gauge-ring.webp" alt=""></div>
      <div class="d-name"><span class="led ${led}"></span><span class="t" title="${esc(t.host)}">${esc(t.host)}</span></div>
      <div class="d-line">${t.owner && t.owner !== 'externo' ? esc(t.owner) : 'sitio externo'}${t.certDays != null ? ` · cert ${t.certDays} d` : ''}</div>`;
    el.addEventListener('click', () => window.open(t.url, '_blank', 'noopener'));
    return el;
  }
  function renderSites() {
    const list = (S.data?.targets || []).slice().sort((a, b) => (a.ok === false) - (b.ok === false) || a.host.localeCompare(b.host));
    $('sites-grid').replaceChildren(...list.map(siteDial));
    requestAnimationFrame(() => drawRails($('sites-grid')));
    $('sites-hint').textContent = list.length ? `${list.filter((t) => t.ok).length} de ${list.length} en línea` : 'Sin sitios configurados (se descubren por Traefik o EXTRA_URLS)';
  }

  /* ---------- Detalle ---------- */
  async function openDrawer(name) {
    S.open = name; $('drawer').hidden = false;
    const r = S.data.resources.find((x) => x.name === name); if (!r) return;
    const admin = isAdmin();
    $('drawer-body').innerHTML = `<div class="d-title"><span class="led ${r.status === 'running' ? '' : idleAux(r) ? 'idle' : 'bad'}"></span><h3>${esc(r.name)}</h3></div>
      <div class="c-sub">${esc((r.hosts || []).join(' · '))}</div>
      <div class="c-meta" style="margin-top:6px"><span>CPU ${pct(r.cpu)}</span><span>RAM ${bytes(r.mem)}</span><span>↓ ${rate(r.rx)}</span><span>↑ ${rate(r.tx)}</span></div>
      <div class="d-grid">
        <div class="d-sec"><h4>Historial</h4><div class="seg" id="hrs"><button data-h="1">1 h</button><button data-h="24" class="on">24 h</button><button data-h="168">7 d</button></div><div id="ch-cpu"></div><div id="ch-mem" style="margin-top:8px"></div></div>
        <div class="d-sec"><h4>Contenedores</h4><table class="ctable" id="ctab"></table></div>
        <div class="d-sec" id="sites"></div>
        <div class="d-sec"><h4>Registro</h4><pre class="logs" id="logs">Elegí un contenedor para ver sus últimas líneas.</pre></div></div>`;
    const ct = $('ctab');
    r.containers.forEach((c) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${esc(c.name)}</td><td>${esc(c.status)}</td><td><div class="row-btns"><button class="btn small" data-a="logs">Logs</button>${admin ? `<button class="btn small warn" data-a="restart">${c.state === 'running' ? 'Reiniciar' : 'Iniciar'}</button>` : ''}</div></td>`;
      tr.querySelector('[data-a=logs]').onclick = async () => { $('logs').textContent = 'Cargando…'; try { $('logs').textContent = (await api(`/api/containers/${c.id}/logs?tail=120`)) || '(sin salida)'; } catch (e) { $('logs').textContent = e.message; } };
      const rb = tr.querySelector('[data-a=restart]');
      if (rb) rb.onclick = async () => { if (!confirm(`¿${c.state === 'running' ? 'Reiniciar' : 'Iniciar'} ${c.name}?`)) return; rb.disabled = true; try { await api(`/api/containers/${c.id}/restart`, { method: 'POST', body: {} }); rb.textContent = 'Listo'; } catch (e) { alert(e.message); rb.disabled = false; } };
      ct.append(tr);
    });
    if (r.sites?.length) $('sites').innerHTML = '<h4>Sitios</h4>' + r.sites.map((s) => `<div class="c-meta"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.host)}</a><span class="${s.ok ? 'ok' : 'bad'}">${s.ok ? 'en línea' : 'sin respuesta'}</span><span>${s.ms ?? '–'} ms</span><span>prom. ${s.avgMs ?? '–'} ms</span><span>${s.up24 != null ? s.up24.toFixed(1) + '% 24h' : ''}</span></div>`).join('');
    const load = async (h) => { const rows = await api(`/api/history/${encodeURIComponent(name)}?hours=${h}`).catch(() => []); $('ch-cpu').replaceChildren(chartSvg(rows, 'cpu', pct, '#38e8ff')); $('ch-mem').replaceChildren(chartSvg(rows, 'mem', bytes, '#c9964a')); };
    $('hrs').onclick = (e) => { const b = e.target.closest('button'); if (!b) return; [...$('hrs').children].forEach((x) => x.classList.toggle('on', x === b)); load(b.dataset.h); };
    load(24);
  }
  const closeDrawer = () => { $('drawer').hidden = true; S.open = null; };
  $('drawer-x').onclick = closeDrawer;
  $('drawer').addEventListener('click', (e) => { if (e.target.id === 'drawer') closeDrawer(); });

  /* ---------- Registro y pendientes ---------- */
  function renderEvents() {
    $('events').innerHTML = S.events.length ? S.events.map((e) => `<li class="${esc(e.level)}"><time>${ago(e.ts)}</time><span>${esc(e.message)}</span></li>`).join('') : '<li class="empty">Sin novedades.</li>';
    const n = $('notes'); n.innerHTML = S.notes.length ? '' : '<li class="empty">Nada pendiente.</li>';
    S.notes.forEach((x) => {
      const li = document.createElement('li');
      li.innerHTML = `<div>${esc(x.text)}<br><small>${x.kind === 'manana' ? 'para ' + esc(x.due) : 'pendiente'} · ${esc(x.user.split('@')[0])}</small></div>`;
      if (isAdmin()) { const b = document.createElement('button'); b.className = 'btn small'; b.textContent = 'Hecho'; b.onclick = async () => { await api(`/api/notes/${x.id}/done`, { method: 'POST', body: {} }); refresh(); }; li.append(b); }
      n.append(li);
    });
  }

  /* ---------- Accesos (superadmin) ---------- */
  async function renderAccess() {
    if (!isSuper()) return;
    const list = await api('/api/users').catch(() => []);
    const t = $('users');
    t.innerHTML = '<tr><th>Usuario</th><th>Trato</th><th>Cargo</th><th>Rol</th><th>Último ingreso</th><th>Estado</th><th></th></tr>';
    list.forEach((u) => {
      const tr = document.createElement('tr'); const me = u.email === S.me.email;
      tr.innerHTML = `<td><div class="u-who"><span class="avatar"></span><div><input class="mini-in" data-a="name" value="${esc(u.name)}" aria-label="Nombre"><small class="mono">${esc(u.email)}</small></div></div></td>
        <td><input class="mini-in" data-a="call" value="${esc(u.call || '')}" size="9" aria-label="Cómo lo llama Puma"></td>
        <td><input class="mini-in" data-a="title" value="${esc(u.title || '')}" size="24" aria-label="Cargo"></td>
        <td><select data-a="role" ${me ? 'disabled' : ''}>${['superadmin', 'admin', 'viewer'].map((r) => `<option value="${r}" ${u.role === r ? 'selected' : ''}>${ROLE[r]}</option>`).join('')}</select></td>
        <td class="mono">${u.lastLogin ? ago(u.lastLogin) : 'nunca'}</td>
        <td>${u.disabled ? '<span class="d-line"><span class="bad">desactivado</span></span>' : u.mustChange ? '<span class="d-line"><span class="warn">debe cambiar clave</span></span>' : '<span class="d-line"><span class="ok">activo</span></span>'}</td>
        <td><div class="acts"><button class="btn small" data-a="reset">Resetear clave</button>${me ? '' : `<button class="btn small" data-a="toggle">${u.disabled ? 'Activar' : 'Desactivar'}</button><button class="btn small warn" data-a="del">Borrar</button>`}</div></td>`;
      setAvatar(tr.querySelector('.avatar'), u);
      const act = async (body, ok) => { try { await api(`/api/users/${encodeURIComponent(u.email)}`, { method: 'PATCH', body }); renderAccess(); if (ok) alert(ok); } catch (e) { alert(e.message); renderAccess(); } };
      ['name', 'call', 'title'].forEach((k) => { const i = tr.querySelector(`[data-a=${k}]`); i.onchange = () => act({ [k]: i.value }); });
      tr.querySelector('[data-a=role]').onchange = (e) => act({ role: e.target.value });
      tr.querySelector('[data-a=reset]').onclick = () => { const p = prompt(`Nueva clave temporal para ${u.email} (mín. 10 caracteres). Tendrá que cambiarla al entrar.`); if (p) act({ password: p }, 'Clave reseteada.'); };
      const tg = tr.querySelector('[data-a=toggle]'); if (tg) tg.onclick = () => act({ disabled: !u.disabled });
      const dl = tr.querySelector('[data-a=del]'); if (dl) dl.onclick = async () => { if (!confirm(`¿Borrar el acceso de ${u.email}?`)) return; try { await api(`/api/users/${encodeURIComponent(u.email)}`, { method: 'DELETE' }); renderAccess(); } catch (e) { alert(e.message); } };
      t.append(tr);
    });
    const au = await api('/api/audit').catch(() => []);
    $('audit').innerHTML = au.slice(0, 40).map((a) => `<li><time>${ago(a.ts)}</time><span>${esc(a.user.split('@')[0])} · ${esc(a.action)} ${esc(a.detail)}</span></li>`).join('') || '<li class="empty">Sin registros.</li>';
  }
  $('new-user').onsubmit = async (e) => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target)); const m = $('nu-msg'); m.className = '';
    try { await api('/api/users', { method: 'POST', body: f }); m.textContent = 'Acceso creado. La persona deberá cambiar la clave al entrar.'; m.className = 'ok'; e.target.reset(); renderAccess(); }
    catch (er) { m.textContent = er.message; }
  };

  /* ---------- Perfil ---------- */
  function renderProfile() {
    setAvatar($('avatar-profile'), S.me); $('p-name').value = S.me.name;
    $('p-full').textContent = S.me.name; $('p-title').textContent = [S.me.title, ROLE[S.me.role]].filter(Boolean).join(' · '); $('p-mail').textContent = S.me.email;
  }
  $('name-form').onsubmit = async (e) => { e.preventDefault(); try { await api('/api/me/name', { method: 'POST', body: { name: $('p-name').value } }); S.me.name = $('p-name').value; paintMe(); } catch (er) { alert(er.message); } };
  $('pw-form').onsubmit = async (e) => {
    e.preventDefault(); const m = $('pw-msg'); m.className = '';
    try { await api('/api/me/password', { method: 'POST', body: { current: $('pw-cur').value, next: $('pw-new').value } }); m.textContent = 'Clave actualizada.'; m.className = 'ok'; e.target.reset(); }
    catch (er) { m.textContent = er.message; }
  };
  $('photo-file').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try {
      let img;
      try { img = await createImageBitmap(f); }
      catch {
        img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('No pude leer esa imagen. Si es una foto de iPhone (HEIC), convertila a JPG o PNG.')); i.src = URL.createObjectURL(f); });
      }
      const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d');
      const w = img.width, h = img.height, s = Math.min(w, h);
      g.drawImage(img, (w - s) / 2, (h - s) / 2, s, s, 0, 0, 256, 256);
      let d = c.toDataURL('image/webp', 0.85); if (!d.startsWith('data:image/webp')) d = c.toDataURL('image/jpeg', 0.85);
      await api('/api/me/photo', { method: 'POST', body: { photo: d } }); S.me.photo = d; paintMe(); renderProfile();
    } catch (er) { alert('No se pudo subir la foto: ' + (er?.message || 'error desconocido')); }
    e.target.value = '';
  };
  $('photo-del').onclick = async () => { await api('/api/me/photo', { method: 'POST', body: { photo: '' } }); S.me.photo = ''; paintMe(); renderProfile(); };

  /* ---------- Navegación ---------- */
  function paintMe() {
    setAvatar($('avatar-top'), S.me); setAvatar($('avatar-menu'), S.me);
    $('m-name').textContent = S.me.name; $('m-role').textContent = S.me.title || ROLE[S.me.role];
    $('who-name').textContent = S.me.name; $('who-title').textContent = S.me.title || ROLE[S.me.role];
    document.querySelectorAll('[data-super]').forEach((b) => { b.hidden = !isSuper(); });
  }
  function show(view) {
    if (view === 'access' && !isSuper()) view = 'panel';
    S.view = view;
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'v-' + view; });
    document.querySelectorAll('#menu [data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    $('view-title').textContent = TITLES[view];
    $('menu').hidden = true; window.scrollTo(0, 0);
    if (view === 'access') renderAccess();
    if (view === 'profile') renderProfile();
    if (view === 'panel') setTimeout(() => { try { fitAddon?.fit(); } catch { /* aún no hay terminal */ } }, 50);
  }
  $('burger').onclick = () => { $('menu').hidden = !$('menu').hidden; };
  $('menu').addEventListener('click', (e) => { if (e.target.id === 'menu') $('menu').hidden = true; });
  document.querySelectorAll('#menu [data-view]').forEach((b) => { b.onclick = () => show(b.dataset.view); });
  $('avatar-top').onclick = () => show('profile');

  /* ---------- Datos ---------- */
  async function refresh() {
    try {
      const [st, ev, nt, un] = await Promise.all([api('/api/state'), api('/api/events?limit=40'), api('/api/notes'), api('/api/messages/unread').catch(() => ({ count: 0, from: {} }))]);
      S.data = st; S.events = ev; S.notes = nt;
      renderSides(); renderCards(); renderSites(); renderEvents(); renderRecent();
      const bad = (S.data.resources || []).filter((r) => r.kind !== 'sistema' && r.status !== 'running').length + (S.data.targets || []).filter((t) => t.ok === false).length;
      S.idleMood = !S.data.docker.ok || bad >= 3 ? 'alert' : bad ? 'serious' : 'calm';
      if (!talk && eye.dataset.state === 'idle' && eye.dataset.mood !== 'thinking') setMood(idleMood());
      setUnread(un);
    } catch (e) { if (e.status === 401) location.reload(); else $('say').textContent = 'Sin conexión con la estación: ' + e.message; }
  }
  async function brief(force) {
    try { const b = await api('/api/briefing', { method: 'POST', body: { force: !!force } }); S.lastBrief = b.text; await speak(b.text); }
    catch (e) { $('say').textContent = 'No pude armar el informe: ' + e.message; }
  }

  /* ---------- Terminal (debajo de la cabeza) ---------- */
  let ws = null, term = null, fitAddon = null;
  function termMsg(html) { const o = $('term-off'); o.innerHTML = html; o.hidden = !html; }
  async function connectTerm() {
    if (!S.me.terminal) { termMsg(S.me.role === 'viewer' ? 'Tu rol es de solo lectura: la terminal es para administradores.' : 'La terminal está desactivada (TERMINAL_ENABLED=0).'); $('term-btn').hidden = true; return; }
    if (ws) { ws.close(); return; }
    termMsg(''); $('term-btn').textContent = 'Desconectar'; $('term-host').textContent = S.me.terminalLabel || '';
    if (!term) {
      term = new Terminal({ cursorBlink: true, fontFamily: '"Share Tech Mono", monospace', fontSize: 13, theme: { background: '#010609', foreground: '#cdeff8', cursor: '#38e8ff' } });
      fitAddon = new FitAddon.FitAddon(); term.loadAddon(fitAddon); term.open($('term'));
      new ResizeObserver(() => { try { fitAddon.fit(); } catch { /* oculto */ } }).observe($('term'));
      term.onData((d) => ws?.readyState === 1 && ws.send(JSON.stringify({ t: 'i', d })));
    }
    term.reset(); try { fitAddon.fit(); } catch { /* nada */ }
    const t0 = Date.now(); let got = false;
    ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws/terminal');
    ws.onopen = () => ws.send(JSON.stringify({ t: 'init', cols: term.cols, rows: term.rows }));
    ws.onmessage = (e) => { try { const m = JSON.parse(e.data); if (m.t === 'o') { got = true; term.write(m.d); } } catch { /* ignora */ } };
    ws.onclose = async () => {
      ws = null; $('term-btn').textContent = 'Conectar';
      term?.write('\r\n\x1b[33m[sesión cerrada]\x1b[0m\r\n');
      if (Date.now() - t0 < 6000 && S.me.terminalMode === 'ssh') await setupHint();
    };
    term.focus();
  }
  async function setupHint() {
    let key = '';
    if (isSuper()) key = await api('/api/terminal/pubkey').catch(() => '');
    termMsg(`<div>No pude abrir la terminal en el servidor. Falta crear el usuario sin privilegios <b>estacion</b>. En el VPS ejecutá:${key ? `<code>sudo bash crear-usuario-estacion.sh "${esc(key)}"</code>` : '<br>(pedile la clave pública al superadmin)'}<br><small>Más detalle en el README, sección Terminal.</small></div>`);
  }
  $('term-btn').onclick = connectTerm;

  /* ---------- Cierre de jornada ---------- */
  let rec = null;
  async function openClose() { $('menu').hidden = true; const q = await api('/api/closing/question'); $('close-modal').hidden = false; $('close-text').value = ''; $('close-q').textContent = q.text; speak(q.text); }
  async function sendClose() {
    $('close-send').disabled = true;
    try { const out = await api('/api/closing/answer', { method: 'POST', body: { text: $('close-text').value } }); $('close-modal').hidden = true; await speak(out.reply); await logout(); }
    catch (e) { alert(e.message); }
    $('close-send').disabled = false;
  }
  async function logout() { try { await api('/api/auth/logout', { method: 'POST', body: {} }); } catch { /* ya salió */ } location.reload(); }
  $('close-cancel').onclick = () => { stopSpeech(); rec?.stop(); $('close-modal').hidden = true; setEye('idle'); };
  $('close-send').onclick = sendClose;
  $('close-mic').onclick = () => { const b = $('close-mic'); b.disabled = true; const base = $('close-text').value; rec = listen((t) => { $('close-text').value = (base ? base + ' ' : '') + t; }, (ok) => { b.disabled = false; if (!ok) alert('Tu navegador no permite dictado; escribí la respuesta.'); }); };
  $('m-off').onclick = openClose;
  $('p-logout').onclick = logout;
  $('m-brief').onclick = () => { $('menu').hidden = true; show('panel'); brief(true); };
  $('m-voice').onclick = () => { S.voice = !S.voice; if (!S.voice) stopSpeech(); setEye('idle'); $('m-voice').textContent = 'Voz: ' + (S.voice ? 'activada' : 'silenciada'); };
  $('say').onclick = () => { if (S.lastBrief) speak(S.lastBrief); };

  /* ---------- Novedades, buzón ---------- */
  function renderRecent() {
    $('recent').innerHTML = S.events.length ? S.events.slice(0, 7).map((e) => `<li class="${esc(e.level)}"><time>${ago(e.ts)}</time><span>${esc(e.message)}</span></li>`).join('') : '<li class="empty">Sin novedades.</li>';
  }
  const stamp = (ts) => new Date(ts * 1000).toLocaleString('es-AR', { timeZone: 'America/Argentina/Mendoza', hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  function setUnread(un) {
    const n = un.count || 0, changed = n !== S.unread;
    S.unread = n; S.unreadFrom = un.from || {};
    $('mail-badge').hidden = !n; $('mail-badge').textContent = n;
    $('m-mail-n').hidden = !n; $('m-mail-n').textContent = n;
    if (S.view === 'panel' && document.visibilityState === 'visible' && (changed || (S.unreadFrom[S.mailWith] || 0) > 0)) loadMail();
  }
  async function initMail() {
    S.people = await api('/api/people').catch(() => []);
    const sel = $('mail-with');
    sel.innerHTML = S.people.map((p) => `<option value="${esc(p.email)}">${esc(p.call || p.name)}</option>`).join('');
    sel.hidden = S.people.length < 2;
    S.mailWith = S.people[0]?.email || '';
    sel.value = S.mailWith;
    sel.onchange = () => { S.mailWith = sel.value; loadMail(); };
    $('mail-form').hidden = !S.mailWith;
    if (!S.mailWith) { $('mail-name').textContent = 'Buzón'; $('mail-log').innerHTML = '<p class="empty">No hay otra persona con acceso para dejarle mensajes.</p>'; return; }
    loadMail();
  }
  async function loadMail() {
    const who = S.people.find((p) => p.email === S.mailWith); if (!who) return;
    $('mail-name').textContent = who.name; $('mail-title').textContent = who.title || '';
    setAvatar($('mail-av'), who);
    const rows = await api('/api/messages?with=' + encodeURIComponent(S.mailWith)).catch(() => null);
    if (!rows) return;
    const log = $('mail-log'), stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    log.innerHTML = rows.length ? rows.map((m) => `<div class="msg${m.from_email === S.me.email ? ' me' : ''}">${esc(m.text)}<time>${stamp(m.ts)}</time></div>`).join('') : `<p class="empty">Todavía no hay mensajes. Dejale uno a ${esc(who.call || who.name)}.</p>`;
    if (stick || rows.length < 4) log.scrollTop = log.scrollHeight;
    if (S.unreadFrom[S.mailWith]) { S.unread = Math.max(0, S.unread - S.unreadFrom[S.mailWith]); S.unreadFrom[S.mailWith] = 0; $('mail-badge').hidden = !S.unread; $('mail-badge').textContent = S.unread; $('m-mail-n').hidden = !S.unread; $('m-mail-n').textContent = S.unread; }
  }
  $('mail-form').onsubmit = async (e) => {
    e.preventDefault(); const t = $('mail-in').value.trim(); if (!t || !S.mailWith) return;
    $('mail-in').value = '';
    try { await api('/api/messages', { method: 'POST', body: { to: S.mailWith, text: t } }); loadMail(); } catch (er) { alert(er.message); $('mail-in').value = t; }
  };
  const goMail = () => { $('menu').hidden = true; show('panel'); setTimeout(() => { $('mail').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('mail-in').focus({ preventScroll: true }); loadMail(); }, 60); };
  $('mail-top').onclick = goMail; $('m-mail').onclick = goMail;

  /* ---------- Puma: chat flotante ("Hey Puma") ---------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const CH = { open: false, hist: [], wake: false, wakeRec: null, awaiting: 0, speaking: false, voice: true, mic: null, started: false };
  const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const WAKE = /\b(?:hey|ey|hei|hay|oye|ok|hola)[\s,.]*puma\b[\s,.:;!?-]*/;
  const chatState = (t) => { $('chat-state').textContent = t; };
  const idleState = () => chatState(CH.wake ? 'Escuchando «Hey Puma»…' : 'Decí «Hey Puma» o escribime');

  function bubble(role, text) {
    const d = document.createElement('div'); d.className = 'msg' + (role === 'user' ? ' me' : '');
    d.textContent = text; $('chat-log').append(d); $('chat-log').scrollTop = $('chat-log').scrollHeight; return d;
  }
  function proposal(p) {
    const d = document.createElement('div'); d.className = 'prop';
    d.innerHTML = `<b>Puma necesita tu autorización</b><span>${esc(p.label)}</span><div class="row"><button class="btn small" data-ok>Autorizar</button><button class="btn small warn" data-no>Rechazar</button></div>`;
    const go = async (accept) => {
      d.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      try {
        const out = await api('/api/agent/confirm', { method: 'POST', body: { id: p.id, accept } });
        d.remove(); const b = bubble('puma', out.text); chatSpeak(out.text);
        if (accept && out.done) { refresh(); loadMail(); }
        return b;
      } catch (er) { d.remove(); bubble('puma', er.message); }
    };
    d.querySelector('[data-ok]').onclick = () => go(true);
    d.querySelector('[data-no]').onclick = () => go(false);
    $('chat-log').append(d); $('chat-log').scrollTop = $('chat-log').scrollHeight;
  }
  function chatSpeak(text) {
    if (!CH.voice) return Promise.resolve();
    pauseWake(); CH.speaking = true;
    return speak(text, true).finally(() => { CH.speaking = false; resumeWake(); });
  }
  async function sendChat(text) {
    text = String(text || '').trim(); if (!text) return;
    openChat(); bubble('user', text); chatState('Pensando…'); setMood('thinking');
    const wait = bubble('puma', '…');
    try {
      const out = await api('/api/agent', { method: 'POST', body: { text, history: CH.hist.slice(-8) } });
      wait.textContent = out.reply;
      CH.hist.push({ role: 'user', content: text }, { role: 'assistant', content: out.reply });
      if (out.proposal) proposal(out.proposal);
      idleState(); setMood(moodFor(out.reply)); await chatSpeak(out.reply); setMood(idleMood());
    } catch (e) { wait.textContent = 'No pude responder: ' + e.message; idleState(); setMood(idleMood()); }
  }
  function openChat() {
    if (!CH.open) {
      CH.open = true; $('puma-chat').hidden = false;
      if (!CH.started) { CH.started = true; const n = S.me.call || S.me.name; const g = S.me.boss ? `Hola ${n}, jefe. Decime qué necesitás.` : `Hola ${n}. Contame qué necesitás: estado de los sistemas, seguridad o un aviso para Roberto.`; bubble('puma', g); }
      idleState();
    }
    setTimeout(() => $('chat-in').focus({ preventScroll: true }), 50);
  }
  const closeChat = () => { CH.open = false; $('puma-chat').hidden = true; stopSpeech(); setEye('idle'); };

  // Escucha de fondo: despierta con «Hey Puma»
  function heard(text) {
    const n = norm(text), m = n.match(WAKE);
    if (m) {
      const rest = text.slice(m.index + m[0].length).trim();
      openChat();
      if (rest.split(/\s+/).filter(Boolean).length >= 2) { CH.awaiting = 0; sendChat(rest); }
      else { CH.awaiting = Date.now() + 9000; chatState('Te escucho…'); setEye('listening'); }
    } else if (CH.awaiting > Date.now()) { CH.awaiting = 0; setEye('idle'); sendChat(text); }
  }
  function startWake() {
    if (!SR) { chatState('Este navegador no permite escuchar por voz'); setWake(false); return; }
    if (CH.wakeRec || !CH.wake || CH.speaking || CH.mic) return;
    const r = new SR(); r.lang = 'es-AR'; r.continuous = true; r.interimResults = false;
    r.onresult = (e) => { for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) heard(e.results[i][0].transcript.trim()); };
    r.onerror = (e) => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { setWake(false); chatState('Permiso de micrófono denegado'); } };
    r.onend = () => { CH.wakeRec = null; if (CH.wake && !CH.speaking && !CH.mic) setTimeout(startWake, 400); };
    try { r.start(); CH.wakeRec = r; } catch { /* ya activo */ }
  }
  function pauseWake() { const r = CH.wakeRec; CH.wakeRec = null; try { r?.abort(); } catch { /* nada */ } }
  function resumeWake() { if (CH.wake) setTimeout(startWake, 500); }
  function setWake(on) {
    CH.wake = on; $('chat-wake').classList.toggle('on', on); $('chat-wake').setAttribute('aria-pressed', on);
    $('puma-fab').classList.toggle('listening', on);
    try { localStorage.setItem('puma.wake', on ? '1' : '0'); } catch { /* sin storage */ }
    if (on) startWake(); else pauseWake();
    if (CH.open) idleState();
  }
  function initChat() {
    $('puma-fab').hidden = false;
    let saved = '0'; try { saved = localStorage.getItem('puma.wake') || '0'; } catch { /* sin storage */ }
    if (saved === '1' && SR && !CH.wake) setWake(true);
  }
  $('puma-fab').onclick = () => (CH.open ? closeChat() : openChat());
  $('chat-x').onclick = closeChat;
  $('m-puma').onclick = () => { $('menu').hidden = true; openChat(); };
  $('chat-wake').onclick = () => setWake(!CH.wake);
  $('chat-voice').onclick = () => { CH.voice = !CH.voice; $('chat-voice').classList.toggle('on', CH.voice); $('chat-voice').setAttribute('aria-pressed', CH.voice); if (!CH.voice) { stopSpeech(); setEye('idle'); } };
  $('chat-form').onsubmit = (e) => { e.preventDefault(); const t = $('chat-in').value; $('chat-in').value = ''; sendChat(t); };
  $('chat-mic').onclick = () => {
    if (!SR) { alert('Tu navegador no permite dictado por voz; escribile a Puma.'); return; }
    if (CH.mic) { CH.mic.stop(); return; }
    pauseWake(); const b = $('chat-mic'); b.classList.add('live'); chatState('Te escucho…'); let last = '';
    CH.mic = listen((t) => { last = t; $('chat-in').value = t; }, () => {
      CH.mic = null; b.classList.remove('live'); idleState(); resumeWake();
      const t = last.trim(); if (t) { $('chat-in').value = ''; sendChat(t.replace(WAKE, '').trim() || t); }
    });
    if (!CH.mic) { b.classList.remove('live'); resumeWake(); }
  };

  /* ---------- Acceso ---------- */
  function enter(speakBrief) {
    $('gate').hidden = true; $('app').hidden = false;
    paintMe(); show('panel'); initMail(); initChat();
    refresh().then(() => { S.timer = setInterval(refresh, Math.max(5, S.data?.sampleSec || 30) * 1000); });
    if (S.me.terminal && !S.termStarted) { S.termStarted = true; connectTerm(); } else if (!S.me.terminal) connectTerm();
    if (speakBrief) brief(false); else $('say').textContent = 'Tocá el mensaje o el menú → Informe hablado para escuchar el informe.';
  }
  async function afterLogin(speakBrief) {
    S.me = await api('/api/me');
    if (S.me.mustChange) { $('force-modal').hidden = false; $('gate').hidden = true; return; }
    enter(speakBrief);
  }
  $('gate-open').onclick = () => { $('gate-open').hidden = true; $('login').hidden = false; $('l-email').focus(); };
  $('login').onsubmit = async (e) => {
    e.preventDefault(); $('l-err').textContent = '';
    try { await api('/api/auth/login', { method: 'POST', body: { email: $('l-email').value, password: $('l-pass').value } }); $('l-pass').value = ''; await afterLogin(true); }
    catch (er) { $('l-err').textContent = er.message; }
  };
  $('force-form').onsubmit = async (e) => {
    e.preventDefault(); $('f-err').textContent = '';
    try { await api('/api/me/password', { method: 'POST', body: { current: $('f-cur').value, next: $('f-new').value } }); $('force-modal').hidden = true; await afterLogin(true); }
    catch (er) { $('f-err').textContent = er.message; }
  };

  ['q', 'f-kind', 'f-sort'].forEach((id) => $(id).addEventListener('input', renderCards));
  $('f-group').onchange = (e) => { S.group = e.target.checked; renderCards(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (!$('drawer').hidden) closeDrawer(); else if (!$('menu').hidden) $('menu').hidden = true; else if (CH.open) closeChat(); } });
  setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString('es-AR', { hour12: false, timeZone: 'America/Argentina/Mendoza' }); }, 1000);

  // ¿Ya hay sesión abierta?
  api('/api/me').then(async (me) => { S.me = me; if (me.mustChange) { $('force-modal').hidden = false; $('gate').hidden = true; } else enter(false); }).catch(() => { /* muestra el acceso */ });
})();
