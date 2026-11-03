import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import http from 'node:http';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/app.js';
import { ensureCertificates } from '../server/tls.js';
import { dualProtocolServer } from '../server/dual.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let hasOpenssl = true;
try { execFileSync('openssl', ['version']); } catch { hasOpenssl = false; }
const skip = hasOpenssl ? false : 'openssl не установлен';

let tmp;
let certs;
let server;
let port;

function get(mod, url, options = {}) {
  return new Promise((resolve, reject) => {
    mod.get(url, options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
}

before(async () => {
  if (skip) return;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'carvolume-tls-'));
  certs = await ensureCertificates(path.join(tmp, 'tls'), ['127.0.0.1', 'localhost', 'carvolume.local']);
  const { server: app } = await createApp({
    driver: { name: 'test', async apply() {} },
    publicDir: path.join(root, 'public'),
    tls: { key: certs.key, cert: certs.cert },
    caCert: certs.ca,
  });
  server = dualProtocolServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(async () => {
  if (skip) return;
  await new Promise((r) => server.close(r));
  await fs.rm(tmp, { recursive: true, force: true });
});

test('сертификат сервера подписан своим CA и содержит адреса устройства', { skip }, () => {
  const cert = new X509Certificate(certs.cert);
  const ca = new X509Certificate(certs.ca);
  assert.ok(cert.verify(ca.publicKey));
  assert.ok(ca.ca);
  assert.match(cert.subjectAltName, /IP Address:127\.0\.0\.1/);
  assert.match(cert.subjectAltName, /DNS:carvolume\.local/);
  const days = (new Date(cert.validTo) - Date.now()) / 864e5;
  assert.ok(days <= 825 && days > 800, `срок действия ${days} дней`);
});

test('повторный запуск не пересоздаёт сертификат, а смена адресов — пересоздаёт', { skip }, async () => {
  const dir = path.join(tmp, 'tls');
  const same = await ensureCertificates(dir, ['127.0.0.1', 'localhost', 'carvolume.local']);
  assert.ok(same.cert.equals(certs.cert));
  const changed = await ensureCertificates(dir, ['127.0.0.1', '192.168.4.1']);
  assert.ok(!changed.cert.equals(certs.cert));
  assert.ok(changed.ca.equals(certs.ca), 'корневой сертификат не должен меняться');
  assert.match(new X509Certificate(changed.cert).subjectAltName, /192\.168\.4\.1/);
});

test('сайт и API работают по HTTPS с доверенным сертификатом', { skip }, async () => {
  const page = await get(https, `https://127.0.0.1:${port}/`, { ca: certs.ca });
  assert.equal(page.status, 200);
  assert.match(page.body.toString(), /Carvolume/);
  const state = await get(https, `https://127.0.0.1:${port}/api/state`, { ca: certs.ca });
  assert.equal(JSON.parse(state.body).gains.fl, 50);
});

test('обычный HTTP на том же порту перенаправляется на HTTPS', { skip }, async () => {
  const res = await get(http, `http://127.0.0.1:${port}/api/state?x=1`);
  assert.equal(res.status, 301);
  assert.equal(res.headers.location, `https://127.0.0.1:${port}/api/state?x=1`);
});

test('корневой сертификат можно скачать для установки на телефон', { skip }, async () => {
  const res = await get(https, `https://127.0.0.1:${port}/carvolume-ca.crt`, { ca: certs.ca });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/x-x509-ca-cert');
  assert.ok(res.body.equals(certs.ca));
});
