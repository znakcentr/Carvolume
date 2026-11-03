import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultState, applyPatch, applyPreset, computeGains } from '../public/js/mixer.js';

test('по умолчанию все динамики играют с общей громкостью', () => {
  assert.deepEqual(computeGains(defaultState()), { fl: 50, fr: 50, rl: 50, rr: 50, sub: 50 });
});

test('пресет «Только передние» выключает задние', () => {
  const g = computeGains(applyPreset(defaultState(), 'front'));
  assert.equal(g.fl, 50);
  assert.equal(g.fr, 50);
  assert.equal(g.rl, 0);
  assert.equal(g.rr, 0);
});

test('выключение отдельного динамика', () => {
  const s = applyPatch(defaultState(), { speakers: { rr: { on: false } } });
  const g = computeGains(s);
  assert.equal(g.rr, 0);
  assert.equal(g.rl, 50);
});

test('mute глушит всё', () => {
  const g = computeGains(applyPatch(defaultState(), { muted: true }));
  assert.ok(Object.values(g).every((v) => v === 0));
});

test('фейдер вперёд приглушает задние, баланс влево — правые; саб не трогается', () => {
  const g = computeGains(applyPatch(defaultState(), { master: 100, fader: 50, balance: -100 }));
  assert.deepEqual(g, { fl: 100, fr: 0, rl: 50, rr: 0, sub: 100 });
});

test('уровень динамика умножается на общую громкость', () => {
  const g = computeGains(applyPatch(defaultState(), { master: 80, speakers: { sub: { level: 50 } } }));
  assert.equal(g.sub, 40);
});

test('некорректные значения обрезаются и игнорируются', () => {
  const s = applyPatch(defaultState(), {
    master: 500,
    balance: -999,
    fader: 'abc',
    muted: 'yes',
    speakers: { fl: { level: -5, on: 1 }, hacker: { on: true } },
  });
  assert.equal(s.master, 100);
  assert.equal(s.balance, -100);
  assert.equal(s.fader, 0);
  assert.equal(s.muted, false);
  assert.equal(s.speakers.fl.level, 0);
  assert.equal(s.speakers.fl.on, true);
  assert.equal(s.speakers.hacker, undefined);
});

test('неизвестный пресет возвращает null', () => {
  assert.equal(applyPreset(defaultState(), 'nope'), null);
});
