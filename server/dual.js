// Один порт для HTTPS и HTTP: по первому байту соединения определяем протокол.
// TLS-соединение (байт 0x16) уходит HTTPS-серверу, обычный HTTP получает
// перенаправление на https:// — так адрес открывается, как его ни набери.

import net from 'node:net';
import http from 'node:http';

export function dualProtocolServer(httpsServer) {
  const redirect = http.createServer((req, res) => {
    const host = req.headers.host ?? 'localhost';
    res.writeHead(301, { location: `https://${host}${req.url}`, 'cache-control': 'no-store' });
    res.end();
  });

  const server = net.createServer((socket) => {
    socket.once('data', (chunk) => {
      socket.pause();
      socket.unshift(chunk);
      (chunk[0] === 0x16 ? httpsServer : redirect).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
    socket.on('error', () => socket.destroy());
  });

  server.on('close', () => {
    httpsServer.emit('close');
    redirect.close();
  });
  return server;
}
