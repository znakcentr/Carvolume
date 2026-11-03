// Общая логика микшера: используется и в браузере, и на сервере.
// Состояние описывает «что хочет пользователь», а computeGains превращает его
// в итоговую громкость каждого динамика (0–100 %).

export const SPEAKERS = [
  { id: 'fl', name: 'Передний левый', short: 'ПЛ', zone: 'front', side: 'left' },
  { id: 'fr', name: 'Передний правый', short: 'ПП', zone: 'front', side: 'right' },
  { id: 'rl', name: 'Задний левый', short: 'ЗЛ', zone: 'rear', side: 'left' },
  { id: 'rr', name: 'Задний правый', short: 'ЗП', zone: 'rear', side: 'right' },
  { id: 'sub', name: 'Сабвуфер', short: 'Саб', zone: 'sub', side: 'center' },
];

export const SPEAKER_IDS = SPEAKERS.map((s) => s.id);

export function defaultState() {
  const speakers = {};
  for (const id of SPEAKER_IDS) speakers[id] = { on: true, level: 100 };
  return { master: 50, muted: false, balance: 0, fader: 0, speakers };
}

const only = (ids) => Object.fromEntries(SPEAKER_IDS.map((id) => [id, { on: ids.includes(id) }]));

// Пресеты возвращают «патч», который накладывается на текущее состояние.
export const PRESETS = [
  {
    id: 'all',
    name: 'Все динамики',
    patch: { balance: 0, fader: 0, speakers: only(SPEAKER_IDS) },
  },
  {
    id: 'front',
    name: 'Только передние',
    patch: { balance: 0, fader: 0, speakers: only(['fl', 'fr', 'sub']) },
  },
  {
    id: 'rear',
    name: 'Только задние',
    patch: { balance: 0, fader: 0, speakers: only(['rl', 'rr', 'sub']) },
  },
  {
    id: 'driver',
    name: 'Только водитель',
    patch: { balance: 0, fader: 0, speakers: only(['fl']) },
  },
  {
    id: 'quiet-rear',
    name: 'Тише сзади',
    patch: { balance: 0, fader: 60, speakers: only(SPEAKER_IDS) },
  },
];

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

function num(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.round(clamp(n, min, max)) : fallback;
}

function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

// Накладывает частичное изменение (patch) на состояние и проверяет все значения.
// Неизвестные поля игнорируются, числа обрезаются по допустимому диапазону.
export function applyPatch(state, patch) {
  const base = state ?? defaultState();
  const p = patch && typeof patch === 'object' ? patch : {};
  const next = {
    master: num(p.master, base.master, 0, 100),
    muted: bool(p.muted, base.muted),
    balance: num(p.balance, base.balance, -100, 100),
    fader: num(p.fader, base.fader, -100, 100),
    speakers: {},
  };
  const sp = p.speakers && typeof p.speakers === 'object' ? p.speakers : {};
  for (const id of SPEAKER_IDS) {
    const prev = base.speakers?.[id] ?? { on: true, level: 100 };
    const change = sp[id] && typeof sp[id] === 'object' ? sp[id] : {};
    next.speakers[id] = {
      on: bool(change.on, bool(prev.on, true)),
      level: num(change.level, num(prev.level, 100, 0, 100), 0, 100),
    };
  }
  return next;
}

export function applyPreset(state, presetId) {
  const preset = PRESETS.find((p) => p.id === presetId);
  if (!preset) return null;
  return applyPatch(state, preset.patch);
}

// balance: -100 (только левые) … +100 (только правые)
// fader:   -100 (только задние) … +100 (только передние)
export function computeGains(state) {
  const s = applyPatch(state, {});
  const gains = {};
  for (const spk of SPEAKERS) {
    const cfg = s.speakers[spk.id];
    if (s.muted || !cfg.on) {
      gains[spk.id] = 0;
      continue;
    }
    let g = (s.master / 100) * (cfg.level / 100);
    if (spk.side === 'left') g *= 1 - Math.max(0, s.balance) / 100;
    if (spk.side === 'right') g *= 1 - Math.max(0, -s.balance) / 100;
    if (spk.zone === 'front') g *= 1 - Math.max(0, -s.fader) / 100;
    if (spk.zone === 'rear') g *= 1 - Math.max(0, s.fader) / 100;
    gains[spk.id] = Math.round(g * 100);
  }
  return gains;
}
