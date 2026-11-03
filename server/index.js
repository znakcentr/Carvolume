import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createDriver } from './drivers.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.env.CONFIG ?? path.join(root, 'config.json');

let config = {};
if (fs.existsSync(configPath)) {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  console.log(`Конфигурация: ${configPath}`);
} else {
  console.log('config.json не найден — запуск в демо-режиме (драйвер mock)');
}

const port = Number(process.env.PORT ?? config.port ?? 8080);
const host = process.env.HOST ?? config.host ?? '0.0.0.0';
const driver = createDriver(process.env.DRIVER ?? config.driver ?? 'mock', config.driverOptions ?? {});

const { server } = await createApp({
  driver,
  publicDir: path.join(root, 'public'),
  stateFile: path.join(root, 'data', 'state.json'),
  pin: String(process.env.PIN ?? config.pin ?? ''),
});

server.listen(port, host, () => {
  console.log(`Драйвер: ${driver.name}`);
  console.log(`Пульт динамиков запущен: http://localhost:${port}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  с телефона: http://${a.address}:${port}`);
    }
  }
});
