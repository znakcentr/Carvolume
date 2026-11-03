import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { createDriver } from './drivers.js';
import { ensureCertificates, localHostnames } from './tls.js';
import { dualProtocolServer } from './dual.js';

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

// HTTPS: true — сертификат создаётся автоматически; { cert, key } — свои файлы.
const httpsEnv = process.env.HTTPS;
const httpsConfig = httpsEnv !== undefined ? !['0', 'false', 'no', ''].includes(httpsEnv) : (config.https ?? false);

let tls;
let caCert;
if (httpsConfig) {
  if (typeof httpsConfig === 'object' && httpsConfig.cert && httpsConfig.key) {
    tls = {
      cert: fs.readFileSync(path.resolve(root, httpsConfig.cert)),
      key: fs.readFileSync(path.resolve(root, httpsConfig.key)),
    };
  } else {
    const extra = (typeof httpsConfig === 'object' && httpsConfig.hosts) || [];
    const certs = await ensureCertificates(path.join(root, 'data', 'tls'), localHostnames(extra));
    tls = { key: certs.key, cert: certs.cert };
    caCert = certs.ca;
  }
}

const { server: appServer } = await createApp({
  driver,
  publicDir: path.join(root, 'public'),
  stateFile: path.join(root, 'data', 'state.json'),
  pin: String(process.env.PIN ?? config.pin ?? ''),
  tls,
  caCert,
});

const server = tls ? dualProtocolServer(appServer) : appServer;
const scheme = tls ? 'https' : 'http';

server.listen(port, host, () => {
  console.log(`Драйвер: ${driver.name}`);
  console.log(`Пульт динамиков запущен: ${scheme}://localhost:${port}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  с телефона: ${scheme}://${a.address}:${port}`);
    }
  }
  if (caCert) {
    console.log(`Чтобы телефон доверял сайту, откройте на нём ${scheme}://<адрес>:${port}/carvolume-ca.crt`);
  }
});
