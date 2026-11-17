// The forge's HTTP server: one process, four surfaces.
//
//   GET  /healthz            the env's boot probe (no auth)
//   /{owner}/{repo}.git/*    git smart HTTP (upload-pack v2, receive-pack v0)
//   /api/v3/*                REST v3
//   POST /api/graphql        GraphQL v4
//   POST /mcp                MCP over streamable HTTP
//
// Every API reply is JSON with a non-empty X-GitHub-Request-Id; an unknown route is
// a JSON 404, never HTML. Auth is one bearer token (MAKEFUN_SHOP_TOKEN): a request
// without it, or with a wrong one, is 401 on every API surface.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRestRouter, handleRest, isAuthed } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleGit } from './git.ts';
import { handleMcp } from './mcp.ts';
import { Store } from './store.ts';
import { VIEWER_LOGIN, scenarioUsers } from './scenario.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

let requestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  requestCounter += 1;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${requestCounter}`,
    ...headers,
  });
  res.end(text);
}

function pathOf(req: IncomingMessage): string {
  const url = req.url ?? '/';
  const q = url.indexOf('?');
  return q < 0 ? url : url.slice(0, q);
}

function queryOf(req: IncomingMessage): URLSearchParams {
  const url = req.url ?? '/';
  const q = url.indexOf('?');
  return q < 0 ? new URLSearchParams() : new URLSearchParams(url.slice(q + 1));
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const viewer = scenarioUsers(12)[0];
  const store = new Store(VIEWER_LOGIN, viewer.name, viewer.email);
  const restRoutes = createRestRouter({ store, token }, (req) => {
    const host = req.headers.host ?? '127.0.0.1';
    return `http://${host}`;
  });

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const query = queryOf(req);
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const authed = isAuthed(req, token);

        if (path === '/api/graphql' && method === 'POST') {
          await handleGraphql(store, token, req, res);
          return;
        }

        if (path === '/mcp' && method === 'POST') {
          await handleMcp(store, token, req, res);
          return;
        }

        if (path.startsWith('/api/v3')) {
          const handled = await handleRest(restRoutes, req, res, path, query, authed);
          if (handled) return;
          if (!authed) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch !== null) {
          await handleGit(store, token, req, res, gitMatch[1], gitMatch[2], gitMatch[3] ?? '/', query, authed);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'internal error' });
        } else {
          res.destroy();
        }
      }
    })();
  });
}
