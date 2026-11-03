import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import {
  SPEAKERS,
  PRESETS,
  defaultState,
  applyPatch,
  applyPreset,
  computeGains,
} from '../public/js/mixer.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const MAX_BODY = 16 * 1024;

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('Слишком большой запрос'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Некорректный JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Создаёт HTTP-сервер пульта.
 * @param {object} opts
 * @param {{name:string, apply:(gains:object, state:object)=>Promise<void>}} opts.driver
 * @param {string} opts.publicDir   папка со статикой сайта
 * @param {string} [opts.stateFile] куда сохранять состояние между перезапусками
 * @param {string} [opts.pin]       PIN-код для доступа (если пусто — без пароля)
 */
export async function createApp({ driver, publicDir, stateFile, pin = '' }) {
  let state = defaultState();
  if (stateFile) {
    try {
      state = applyPatch(defaultState(), JSON.parse(await fs.readFile(stateFile, 'utf8')));
    } catch {
      /* первый запуск — используем значения по умолчанию */
    }
  }

  let lastError = null;
  const clients = new Set();

  function snapshot() {
    return { state, gains: computeGains(state), driver: driver.name, error: lastError };
  }

  function broadcast() {
    const data = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const res of clients) res.write(data);
  }

  // Применение к оборудованию выполняется строго по очереди,
  // чтобы быстрые движения ползунка не перемешивали команды.
  let queue = Promise.resolve();
  function commit(next) {
    state = next;
    const gains = computeGains(state);
    const job = queue.then(async () => {
      try {
        await driver.apply(gains, state);
        lastError = null;
      } catch (err) {
        lastError = err.message;
        console.error('[driver]', err.message);
      }
      if (stateFile) {
        await fs.mkdir(path.dirname(stateFile), { recursive: true });
        await fs.writeFile(stateFile, JSON.stringify(state, null, 2)).catch((e) =>
          console.error('[state]', e.message),
        );
      }
      broadcast();
    });
    queue = job;
    return job;
  }

  // Применить сохранённое состояние при старте.
  await commit(state);

  function authorized(req, url) {
    if (!pin) return true;
    const header = req.headers['x-pin'] ?? '';
    const query = url.searchParams.get('pin') ?? '';
    return safeEqual(header || query, pin);
  }

  async function handleApi(req, res, url) {
    if (url.pathname === '/api/info' && req.method === 'GET') {
      return sendJson(res, 200, {
        speakers: SPEAKERS,
        presets: PRESETS.map(({ id, name }) => ({ id, name })),
        pinRequired: Boolean(pin),
      });
    }

    if (!authorized(req, url)) return sendJson(res, 401, { error: 'Нужен PIN-код' });

    if (url.pathname === '/api/state') {
      if (req.method === 'GET') return sendJson(res, 200, snapshot());
      if (req.method === 'PATCH' || req.method === 'POST') {
        const patch = await readBody(req);
        await commit(applyPatch(state, patch));
        return sendJson(res, 200, snapshot());
      }
      return sendJson(res, 405, { error: 'Метод не поддерживается' });
    }

    const presetMatch = url.pathname.match(/^\/api\/presets\/([\w-]+)$/);
    if (presetMatch && req.method === 'POST') {
      const next = applyPreset(state, presetMatch[1]);
      if (!next) return sendJson(res, 404, { error: 'Нет такого пресета' });
      await commit(next);
      return sendJson(res, 200, snapshot());
    }

    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    return sendJson(res, 404, { error: 'Не найдено' });
  }

  async function handleStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(publicDir, '.' + rel);
    if (!file.startsWith(path.resolve(publicDir) + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Не найдено');
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else await handleStatic(req, res, url);
    } catch (err) {
      if (!res.headersSent) sendJson(res, err.status ?? 500, { error: err.message });
      else res.end();
    }
  });

  server.on('close', () => {
    for (const res of clients) res.end();
    clients.clear();
  });

  return { server, getState: () => state };
}
