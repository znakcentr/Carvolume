// Драйверы — то, что физически меняет громкость динамиков.
// Каждый драйвер получает итоговые громкости { fl, fr, rl, rr, sub } в процентах.

import { execFile } from 'node:child_process';
import { SPEAKER_IDS } from '../public/js/mixer.js';

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, { timeout: 5000, ...options }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${cmd}: ${stderr?.trim() || err.message}`));
      else resolve(stdout);
    });
    if (options.input !== undefined) child.stdin.end(options.input);
  });
}

// Ничего не трогает, только пишет в лог. Удобно для проверки сайта.
function mockDriver({ log = true } = {}) {
  return {
    name: 'mock',
    async apply(gains) {
      if (log) console.log('[mock]', SPEAKER_IDS.map((id) => `${id}=${gains[id]}%`).join(' '));
    },
  };
}

// PulseAudio / PipeWire: громкость по каналам многоканального выхода.
// Например, Raspberry Pi + USB-звуковая карта 4.0/5.1 + 4-канальный усилитель.
// channelOrder — порядок каналов выхода (sink), как его показывает `pactl list sinks`.
// Элементом может быть id динамика или число (фиксированная громкость, % ),
// например для центрального канала, который не используется.
function pactlDriver({ sink = '@DEFAULT_SINK@', channelOrder = ['fl', 'fr', 'rl', 'rr'], bin = 'pactl' } = {}) {
  return {
    name: 'pactl',
    async apply(gains) {
      const volumes = channelOrder.map((ch) => {
        const v = typeof ch === 'number' ? ch : gains[ch] ?? 0;
        return `${v}%`;
      });
      await run(bin, ['set-sink-volume', sink, ...volumes]);
    },
  };
}

// Любая своя программа/скрипт: громкости передаются аргументами,
// переменными окружения SPK_FL, SPK_FR, … и JSON-ом в stdin.
function commandDriver({ command, args = [] } = {}) {
  if (!command) throw new Error('Драйвер "command": укажите driverOptions.command');
  return {
    name: 'command',
    async apply(gains, state) {
      const env = { ...process.env };
      for (const id of SPEAKER_IDS) env[`SPK_${id.toUpperCase()}`] = String(gains[id]);
      const allArgs = [...args, ...SPEAKER_IDS.map((id) => `${id}=${gains[id]}`)];
      await run(command, allArgs, { env, input: JSON.stringify({ gains, state }) });
    },
  };
}

// HTTP: отправляет JSON на микроконтроллер (ESP32/ESP8266 с DSP или реле).
function httpDriver({ url, headers = {} } = {}) {
  if (!url) throw new Error('Драйвер "http": укажите driverOptions.url');
  return {
    name: 'http',
    async apply(gains, state) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ gains, state }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`http: устройство ответило ${res.status}`);
    },
  };
}

const DRIVERS = { mock: mockDriver, pactl: pactlDriver, command: commandDriver, http: httpDriver };

export function createDriver(name = 'mock', options = {}) {
  const factory = DRIVERS[name];
  if (!factory) throw new Error(`Неизвестный драйвер "${name}". Доступны: ${Object.keys(DRIVERS).join(', ')}`);
  return factory(options);
}
