const http = require('node:http');
const { openDb } = require('../../src/db');
const { createApiHandlerForDb } = require('../../src/api/routes');

function startTestServer() {
  const db = openDb(':memory:');
  const handleApiRequest = createApiHandlerForDb(db);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    handleApiRequest(req, res, url);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        db,
        baseUrl: `http://127.0.0.1:${port}`,
        async close() {
          db.close();
          await new Promise((res2) => server.close(res2));
        },
      });
    });
  });
}

async function apiFetch(baseUrl, method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : undefined;
  return { status: res.status, body: json };
}

module.exports = { startTestServer, apiFetch };
