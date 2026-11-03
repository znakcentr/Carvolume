import { SPEAKERS, PRESETS, defaultState, applyPatch, applyPreset, computeGains } from './mixer.js';

// Положение кнопок динамиков на схеме машины (в % от размеров схемы).
const POSITIONS = {
  fl: { x: 17, y: 34 },
  fr: { x: 83, y: 34 },
  rl: { x: 17, y: 68 },
  rr: { x: 83, y: 68 },
  sub: { x: 50, y: 91 },
};

const DEMO_KEY = 'carvolume.demo-state';
const PIN_KEY = 'carvolume.pin';

const $ = (sel) => document.querySelector(sel);

const storage = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* приватный режим */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* приватный режим */ }
  },
};

// ---------------------------------------------------------------------------
// Транспорт: сервер в машине или демо-режим в браузере
// ---------------------------------------------------------------------------

let mode = 'connecting'; // 'server' | 'demo'
let state = defaultState();
let gains = computeGains(state);
let driverError = null;
let pin = storage.get(PIN_KEY) ?? '';

// Если есть неотправленные изменения, на сервер уходит всё текущее состояние
// одним запросом; пока запрос в пути, новые изменения просто копятся.
let dirty = false;
let inFlight = false;
let events = null;

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-pin': pin, ...(options.headers ?? {}) },
  });
  if (res.status === 401) {
    const err = new Error('unauthorized');
    err.status = 401;
    throw err;
  }
  if (!res.ok) throw new Error(`Ошибка сервера: ${res.status}`);
  return res.json();
}

function acceptSnapshot(snap) {
  // Пока пользователь двигает ползунок, не перетираем его ввод старыми данными.
  if (inFlight || dirty) return;
  state = applyPatch(defaultState(), snap.state);
  gains = snap.gains ?? computeGains(state);
  driverError = snap.error ?? null;
  render();
}

async function flush() {
  if (inFlight || !dirty) return;
  dirty = false;
  inFlight = true;
  try {
    const snap = await api('/api/state', { method: 'PATCH', body: JSON.stringify(state) });
    inFlight = false;
    if (!dirty) acceptSnapshot(snap);
    setStatus();
  } catch (err) {
    inFlight = false;
    if (err.status === 401) return askPin(Boolean(pin));
    dirty = true; // отправим ещё раз при следующем изменении или переподключении
    setStatus('error', 'Нет связи с машиной');
    return;
  }
  flush();
}

function update(patch) {
  setState(applyPatch(state, patch));
}

function usePreset(id) {
  const next = applyPreset(state, id);
  if (next) setState(next);
}

function setState(next) {
  state = next;
  afterLocalChange();
  if (mode === 'server') {
    dirty = true;
    flush();
  }
}

function afterLocalChange() {
  gains = computeGains(state);
  if (mode === 'demo') storage.set(DEMO_KEY, JSON.stringify(state));
  render();
}

function startDemo() {
  mode = 'demo';
  try {
    const saved = JSON.parse(storage.get(DEMO_KEY) ?? 'null');
    if (saved) state = applyPatch(defaultState(), saved);
  } catch { /* повреждённые данные — начинаем с нуля */ }
  gains = computeGains(state);
  setStatus();
  render();
}

function subscribe() {
  events?.close();
  const url = '/api/events' + (pin ? `?pin=${encodeURIComponent(pin)}` : '');
  events = new EventSource(url);
  events.onopen = () => flush();
  events.onmessage = (e) => {
    setStatus();
    try { acceptSnapshot(JSON.parse(e.data)); } catch { /* пропускаем */ }
  };
  events.onerror = () => setStatus('error', 'Переподключение…');
}

async function connect() {
  let info;
  try {
    const res = await fetch('/api/info', { cache: 'no-store' });
    if (!res.ok) throw new Error();
    info = await res.json();
  } catch {
    // Сайт открыт без сервера (например, просто как файл или со статического хостинга).
    return startDemo();
  }
  mode = 'server';
  if (info.pinRequired && !pin) return askPin();
  try {
    acceptSnapshot(await api('/api/state'));
    subscribe();
    setStatus();
  } catch (err) {
    if (err.status === 401) return askPin(Boolean(pin));
    setStatus('error', 'Нет связи с машиной');
  }
}

function askPin(wrong = false) {
  events?.close();
  setStatus('error', 'Нужен PIN');
  $('#pin-error').hidden = !wrong;
  $('#pin-input').value = '';
  const dlg = $('#pin-dialog');
  if (!dlg.open) dlg.showModal();
}

$('#pin-form').addEventListener('submit', () => {
  pin = $('#pin-input').value.trim();
  storage.set(PIN_KEY, pin);
  connect();
});

// ---------------------------------------------------------------------------
// Интерфейс
// ---------------------------------------------------------------------------

function setStatus(kind, text) {
  const el = $('#status');
  if (!kind) {
    if (mode === 'demo') { kind = 'demo'; text = 'Демо-режим'; }
    else if (driverError) { kind = 'error'; text = 'Ошибка оборудования'; }
    else { kind = 'ok'; text = 'Подключено'; }
  }
  el.className = `status ${kind}`;
  el.title = driverError ?? (mode === 'demo'
    ? 'Сервер в машине не найден — изменения сохраняются только в этом браузере'
    : 'Подключено к контроллеру динамиков');
  $('#status-text').textContent = text;
}

$('#status').addEventListener('click', () => {
  if (mode === 'demo') {
    alert('Демо-режим: сайт открыт без сервера в машине. Изменения сохраняются только в этом браузере.\n\nЧтобы реально управлять динамиками, запустите сервер Carvolume на устройстве в машине и откройте его адрес.');
  } else if (driverError) {
    alert(`Сервер работает, но не смог применить громкость:\n${driverError}`);
  }
});

const speakerButtons = {};
const levelRows = {};

function buildUi() {
  const car = $('#car');
  for (const spk of SPEAKERS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `spk-btn${spk.id === 'sub' ? ' sub' : ''}`;
    btn.style.left = `${POSITIONS[spk.id].x}%`;
    btn.style.top = `${POSITIONS[spk.id].y}%`;
    btn.innerHTML = `<span class="glow"></span><span class="spk-name">${spk.short}</span><span class="spk-val"></span>`;
    btn.addEventListener('click', () => {
      update({ speakers: { [spk.id]: { on: !state.speakers[spk.id].on } } });
    });
    car.append(btn);
    speakerButtons[spk.id] = btn;

    const row = document.createElement('div');
    row.className = 'level';
    row.innerHTML = `
      <button type="button" class="switch" role="switch" aria-label="${spk.name}"></button>
      <div class="level-name">
        <div class="level-top"><span>${spk.name}</span></div>
        <input type="range" min="0" max="100" step="1" aria-label="Уровень: ${spk.name}">
      </div>
      <span class="level-val"></span>`;
    const sw = row.querySelector('.switch');
    const range = row.querySelector('input');
    sw.addEventListener('click', () => update({ speakers: { [spk.id]: { on: !state.speakers[spk.id].on } } }));
    range.addEventListener('input', () => update({ speakers: { [spk.id]: { level: Number(range.value) } } }));
    $('#levels').append(row);
    levelRows[spk.id] = { sw, range, val: row.querySelector('.level-val') };
  }

  for (const preset of PRESETS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'preset';
    b.dataset.id = preset.id;
    b.textContent = preset.name;
    b.addEventListener('click', () => usePreset(preset.id));
    $('#presets').append(b);
  }

  const master = $('#master');
  master.addEventListener('input', () => update({ master: Number(master.value) }));
  $('#mute').addEventListener('click', () => update({ muted: !state.muted }));
  $('#pad-reset').addEventListener('click', () => update({ balance: 0, fader: 0 }));

  setupPad();
}

function setupPad() {
  const pad = $('#pad');
  let dragging = false;

  function fromPointer(e) {
    const r = pad.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    let balance = Math.round(x * 200 - 100);
    let fader = Math.round(100 - y * 200);
    // Небольшая «липкость» к центру, чтобы легко вернуть ровно 0.
    if (Math.abs(balance) < 6) balance = 0;
    if (Math.abs(fader) < 6) fader = 0;
    update({ balance, fader });
  }

  pad.addEventListener('pointerdown', (e) => {
    dragging = true;
    pad.setPointerCapture(e.pointerId);
    pad.classList.add('dragging');
    fromPointer(e);
  });
  pad.addEventListener('pointermove', (e) => { if (dragging) fromPointer(e); });
  const stop = () => { dragging = false; pad.classList.remove('dragging'); };
  pad.addEventListener('pointerup', stop);
  pad.addEventListener('pointercancel', stop);
  pad.addEventListener('dblclick', () => update({ balance: 0, fader: 0 }));

  pad.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 20 : 5;
    const moves = {
      ArrowLeft: { balance: state.balance - step },
      ArrowRight: { balance: state.balance + step },
      ArrowUp: { fader: state.fader + step },
      ArrowDown: { fader: state.fader - step },
      Home: { balance: 0, fader: 0 },
    };
    if (moves[e.key]) {
      e.preventDefault();
      update(moves[e.key]);
    }
  });
}

function describeBalance(v) {
  if (v === 0) return 'Баланс: центр';
  return `Баланс: ${v < 0 ? 'левее' : 'правее'} ${Math.abs(v)}`;
}

function describeFader(v) {
  if (v === 0) return 'Фейдер: центр';
  return `Фейдер: ${v > 0 ? 'вперёд' : 'назад'} ${Math.abs(v)}`;
}

function setRange(input, value) {
  if (document.activeElement !== input || Number(input.value) !== value) input.value = value;
  input.style.setProperty('--pct', `${input.value}%`);
}

function render() {
  for (const spk of SPEAKERS) {
    const cfg = state.speakers[spk.id];
    const g = gains[spk.id];
    const btn = speakerButtons[spk.id];
    btn.classList.toggle('on', cfg.on);
    btn.classList.toggle('off', !cfg.on);
    btn.querySelector('.spk-val').textContent = cfg.on ? `${g}%` : 'выкл';
    btn.style.setProperty('--glow', String(Math.min(1, g / 60)));
    btn.setAttribute('aria-pressed', String(cfg.on));
    btn.setAttribute('aria-label', `${spk.name}: ${cfg.on ? `включён, ${g}%` : 'выключен'}`);

    const row = levelRows[spk.id];
    row.sw.setAttribute('aria-checked', String(cfg.on));
    setRange(row.range, cfg.level);
    row.range.disabled = !cfg.on;
    row.val.textContent = cfg.on ? `${g}%` : '—';
  }

  setRange($('#master'), state.master);
  $('#master-value').textContent = state.muted ? 'Без звука' : `${state.master}%`;
  const mute = $('#mute');
  mute.setAttribute('aria-pressed', String(state.muted));
  mute.title = state.muted ? 'Включить звук' : 'Выключить звук';

  const dot = $('#pad-dot');
  dot.style.left = `${(state.balance + 100) / 2}%`;
  dot.style.top = `${(100 - state.fader) / 2}%`;
  $('#pad').setAttribute('aria-valuetext', `${describeBalance(state.balance)}, ${describeFader(state.fader)}`);
  $('#balance-text').textContent = describeBalance(state.balance);
  $('#fader-text').textContent = describeFader(state.fader);

  const current = JSON.stringify(state);
  for (const b of document.querySelectorAll('.preset')) {
    const next = applyPreset(state, b.dataset.id);
    b.classList.toggle('active', JSON.stringify(next) === current);
  }
}

buildUi();
render();
connect();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
