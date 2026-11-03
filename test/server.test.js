import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { createDriver } from '../server/drivers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function recordingDriver() {
  const calls = [];
  return { name: 'test', calls, async apply(gains) { calls.push(gains); } };
}

let server;
let base;
let driver;
let tmp;

before(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'carvolume-'));
  driver = recordingDriver();
  ({ server } = await createApp({
    driver,
    publicDir: path.join(root, 'public'),
    stateFile: path.join(tmp, 'state.json'),
    pin: '1234',
  }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
  await fs.rm(tmp, { recursive: true, force: true });
});

const auth = { 'x-pin': '1234', 'content-type': 'application/json' };

test('отдаёт сайт', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Carvolume/);
});

test('не выпускает за пределы папки public', async () => {
  const res = await fetch(base + '/%2e%2e/package.json');
  assert.notEqual(res.status, 200);
});

test('info доступен без PIN, состояние — нет', async () => {
  const info = await (await fetch(base + '/api/info')).json();
  assert.equal(info.pinRequired, true);
  assert.equal(info.speakers.length, 5);
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await fetch(base + '/api/state', { headers: { 'x-pin': '0000' } })).status, 401);
});

test('выключаем задние динамики — драйвер получает 0 на задние каналы', async () => {
  const res = await fetch(base + '/api/state', {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ master: 70, speakers: { rl: { on: false }, rr: { on: false } } }),
  });
  assert.equal(res.status, 200);
  const snap = await res.json();
  assert.deepEqual(snap.gains, { fl: 70, fr: 70, rl: 0, rr: 0, sub: 70 });
  assert.deepEqual(driver.calls.at(-1), snap.gains);
});

test('пресет через API', async () => {
  const res = await fetch(base + '/api/presets/rear', { method: 'POST', headers: auth });
  const snap = await res.json();
  assert.equal(snap.gains.fl, 0);
  assert.equal(snap.gains.rl, 70);
  assert.equal((await fetch(base + '/api/presets/xxx', { method: 'POST', headers: auth })).status, 404);
});

test('состояние сохраняется в файл', async () => {
  const saved = JSON.parse(await fs.readFile(path.join(tmp, 'state.json'), 'utf8'));
  assert.equal(saved.speakers.fl.on, false);
  assert.equal(saved.master, 70);
});

test('некорректный JSON — 400', async () => {
  const res = await fetch(base + '/api/state', { method: 'PATCH', headers: auth, body: '{oops' });
  assert.equal(res.status, 400);
});

test('ошибка драйвера показывается в состоянии, сервер не падает', async () => {
  const failing = { name: 'broken', async apply() { throw new Error('усилитель не отвечает'); } };
  const { server: s } = await createApp({ driver: failing, publicDir: path.join(root, 'public') });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const snap = await (await fetch(`http://127.0.0.1:${s.address().port}/api/state`)).json();
  assert.equal(snap.error, 'усилитель не отвечает');
  await new Promise((r) => s.close(r));
});

test('драйвер pactl передаёт громкость по каналам в нужном порядке', async () => {
  const fake = path.join(tmp, 'fake-pactl.sh');
  const out = path.join(tmp, 'pactl-args.txt');
  await fs.writeFile(fake, `#!/bin/sh\necho "$@" > "${out}"\n`, { mode: 0o755 });
  const d = createDriver('pactl', { bin: fake, sink: 'car', channelOrder: ['fl', 'fr', 'rl', 'rr', 100, 'sub'] });
  await d.apply({ fl: 10, fr: 20, rl: 0, rr: 0, sub: 55 });
  assert.equal((await fs.readFile(out, 'utf8')).trim(), 'set-sink-volume car 10% 20% 0% 0% 100% 55%');
});

test('драйвер command получает громкости в аргументах, env и stdin', async () => {
  const fake = path.join(tmp, 'fake-cmd.sh');
  const out = path.join(tmp, 'cmd.txt');
  await fs.writeFile(fake, `#!/bin/sh\necho "$@ | $SPK_RL" > "${out}"\ncat >> "${out}"\n`, { mode: 0o755 });
  const d = createDriver('command', { command: fake });
  await d.apply({ fl: 1, fr: 2, rl: 3, rr: 4, sub: 5 }, { master: 1 });
  const text = await fs.readFile(out, 'utf8');
  assert.match(text, /^fl=1 fr=2 rl=3 rr=4 sub=5 \| 3/);
  assert.match(text, /"gains":\{"fl":1/);
});
