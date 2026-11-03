// Автоматическое создание HTTPS-сертификатов для работы в локальной сети машины.
//
// Схема как у mkcert: создаётся свой корневой сертификат (CA) и подписанный им
// сертификат сервера с IP-адресами устройства. CA можно один раз установить на
// телефон — и браузер перестанет показывать предупреждение.
// Нужна утилита openssl (есть в Raspberry Pi OS, большинстве Linux и macOS).

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';

function openssl(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('openssl', args, { cwd, timeout: 60000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = err.code === 'ENOENT'
          ? 'не найдена утилита openssl. Установите её (sudo apt install openssl) или укажите свои файлы в https.cert и https.key'
          : stderr?.trim() || err.message;
        reject(new Error(`openssl: ${msg}`));
      } else resolve(stdout);
    });
  });
}

const exists = (file) => fs.access(file).then(() => true, () => false);

/** Все имена и адреса, по которым к устройству могут обратиться с телефона. */
export function localHostnames(extra = []) {
  const names = new Set(['localhost', '127.0.0.1', `${os.hostname()}.local`, ...extra]);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) names.add(a.address);
  }
  return [...names].sort();
}

const isIp = (h) => /^\d{1,3}(\.\d{1,3}){3}$/.test(h);

/**
 * Проверяет, что в папке dir есть действующий сертификат для hosts,
 * и при необходимости создаёт/обновляет его.
 * @returns {Promise<{key: Buffer, cert: Buffer, ca: Buffer, caPath: string}>}
 */
export async function ensureCertificates(dir, hosts = localHostnames()) {
  await fs.mkdir(dir, { recursive: true });
  const f = (name) => path.join(dir, name);

  if (!(await exists(f('ca.crt'))) || !(await exists(f('ca.key')))) {
    await openssl([
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '3650',
      '-keyout', 'ca.key', '-out', 'ca.crt',
      '-subj', '/O=Carvolume/CN=Carvolume Local CA',
      '-addext', 'basicConstraints=critical,CA:TRUE',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    ], dir);
    await fs.chmod(f('ca.key'), 0o600);
  }

  // Сертификат сервера пересоздаётся, если поменялись адреса устройства
  // или он скоро истекает (срок — 825 дней, максимум, который принимает iOS).
  const wanted = JSON.stringify(hosts);
  let fresh = false;
  try {
    const meta = JSON.parse(await fs.readFile(f('server.json'), 'utf8'));
    fresh = meta.hosts === wanted && meta.expires > Date.now() + 30 * 864e5 && (await exists(f('server.crt')));
  } catch { /* нет метаданных — создаём заново */ }

  if (!fresh) {
    const san = hosts.map((h) => (isIp(h) ? `IP:${h}` : `DNS:${h}`)).join(',');
    await fs.writeFile(f('server.ext'), [
      'basicConstraints=CA:FALSE',
      'keyUsage=critical,digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
      `subjectAltName=${san}`,
      '',
    ].join('\n'));
    await openssl([
      'req', '-newkey', 'rsa:2048', '-nodes', '-sha256',
      '-keyout', 'server.key', '-out', 'server.csr', '-subj', '/O=Carvolume/CN=Carvolume',
    ], dir);
    await openssl([
      'x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key',
      '-set_serial', `0x${randomBytes(12).toString('hex')}`,
      '-days', '825', '-sha256', '-extfile', 'server.ext', '-out', 'server.crt',
    ], dir);
    await fs.chmod(f('server.key'), 0o600);
    await fs.rm(f('server.csr'), { force: true });
    await fs.writeFile(f('server.json'), JSON.stringify({ hosts: wanted, expires: Date.now() + 825 * 864e5 }));
  }

  return {
    key: await fs.readFile(f('server.key')),
    cert: await fs.readFile(f('server.crt')),
    ca: await fs.readFile(f('ca.crt')),
    caPath: f('ca.crt'),
  };
}
