// Minimal method+path router with JSON in/out, kept dependency-free like the
// rest of the project (no build tooling, no framework -- see routes.js for
// the actual route table).
const { HttpError } = require('./http-error');

// routes: [{ method, path, handler }]. path segments starting with ':'
// capture into params (e.g. '/api/posts/:id/tags/:tagId'). First match wins,
// so a static path (e.g. '/api/posts/stats') must be listed before a
// dynamic one it could otherwise be captured by (e.g. '/api/posts/:id').
function matchRoute(routes, method, pathname) {
  const pathSegments = pathname.split('/').filter(Boolean);
  for (const route of routes) {
    if (route.method !== method) continue;
    const routeSegments = route.path.split('/').filter(Boolean);
    if (routeSegments.length !== pathSegments.length) continue;

    const params = {};
    let matched = true;
    for (let i = 0; i < routeSegments.length; i++) {
      const routeSegment = routeSegments[i];
      const pathSegment = pathSegments[i];
      if (routeSegment.startsWith(':')) {
        params[routeSegment.slice(1)] = pathSegment;
      } else if (routeSegment !== pathSegment) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler: route.handler, params };
  }
  return null;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

// Returns an (req, res, url) request handler: matches the route, parses the
// JSON body for write methods, calls the handler, and serializes its result.
// A thrown HttpError becomes that status + { error }; anything else is a 500.
function createApiHandler(routes) {
  return async function handleApiRequest(req, res, url) {
    const match = matchRoute(routes, req.method, url.pathname);
    if (!match) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    try {
      const needsBody = req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT';
      const body = needsBody ? await readJsonBody(req) : {};
      const result = await match.handler({ params: match.params, query: url.searchParams, body });
      sendJson(res, result.status || 200, result.body);
    } catch (err) {
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.message });
        return;
      }
      console.error(err);
      sendJson(res, 500, { error: 'Internal server error' });
    }
  };
}

module.exports = { createApiHandler, sendJson };
