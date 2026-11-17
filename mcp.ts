// MCP over streamable HTTP (JSON-RPC 2.0) at POST /mcp.
//
// Two protocol eras, one endpoint:
//   modern 2026-07-28: `server/discover` returns identity, capabilities and
//           supportedVersions; every request declares its revision in `_meta`.
//   legacy 2025-11-25 and earlier: `initialize` + `notifications/initialized`.
// The server speaks both: discover answers, and initialize echoes any revision
// it supports. Each POST is answered with one plain JSON body (no SSE stream).
//
// Tools act on the same store as REST and GraphQL, so a repository or issue
// created over MCP reads back identically over REST (same ids). Auth is the
// same bearer token (MAKEFUN_SHOP_TOKEN): no valid Authorization is 401.
// A body that is not JSON is HTTP 400 with JSON-RPC -32700.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { issueJson, pullJson, repoJson, squashMergePull } from './rest.ts';
import type { Issue, PullRequest, Repo, Store } from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const CURRENT_REVISION = '2026-07-28';
const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// ---------------------------------------------------------------- tools

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (defaults to the authenticated user).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue in a repository by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        issue_number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Issue state: open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

const TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

// ---------------------------------------------------------------- helpers

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJsonRpc(res: ServerResponse, status: number, id: string | number | null, payload: Record<string, unknown>): void {
  const text = `${JSON.stringify({ jsonrpc: '2.0', id, ...payload })}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function rpcError(res: ServerResponse, id: string | number | null, code: number, message: string, data?: unknown): void {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  sendJsonRpc(res, 200, id, { error });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** A tool result: text blocks plus the same value as structured content. */
function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

// ---------------------------------------------------------------- tool implementations

function needRepo(store: Store, args: Record<string, unknown>): { repo: Repo } | { error: string } {
  const owner = asString(args.owner);
  const name = asString(args.repo);
  if (owner === null || name === null) return { error: 'Missing required argument: owner or repo' };
  const repo = store.getRepo(owner, name);
  if (repo === undefined) return { error: `Repository not found: ${owner}/${name}` };
  return { repo };
}

function missingRequired(def: ToolDef, args: Record<string, unknown>): string | null {
  for (const name of def.inputSchema.required) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return name;
  }
  return null;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOLS.find((tool) => tool.name === name);
  if (def === undefined) return toolError(`Unknown tool: ${name}`);
  const missing = missingRequired(def, args);
  if (missing !== null) return toolError(`Missing required argument: ${missing}`);

  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name) as string;
      if (store.getRepo(store.viewerLogin, repoName) !== undefined) {
        return toolError(`Repository already exists: ${repoName}`);
      }
      const repo = store.createRepo(repoName, args.private === true, asString(args.description) ?? '');
      return toolResult(repoJson(store, repo));
    }
    case 'get_repo': {
      const found = needRepo(store, args);
      if ('error' in found) return toolError(found.error);
      return toolResult(repoJson(store, found.repo));
    }
    case 'create_issue': {
      const found = needRepo(store, args);
      if ('error' in found) return toolError(found.error);
      const repo = found.repo;
      const issue: Issue = {
        number: repo.nextNumber++,
        title: asString(args.title) as string,
        body: asString(args.body) ?? '',
        state: 'open',
        labels: [],
        seq: repo.issues.length,
        comments: [],
        createdSeq: repo.issues.length,
      };
      repo.issues.push(issue);
      return toolResult(issueJson(store, repo, issue));
    }
    case 'get_issue': {
      const found = needRepo(store, args);
      if ('error' in found) return toolError(found.error);
      const number = asNumber(args.issue_number);
      const issue = number === null ? undefined : found.repo.issues.find((entry) => entry.number === number);
      if (issue === undefined) return toolError(`Issue not found: #${String(args.issue_number)}`);
      return toolResult(issueJson(store, found.repo, issue));
    }
    case 'list_issues': {
      const found = needRepo(store, args);
      if ('error' in found) return toolError(found.error);
      const state = asString(args.state) ?? 'open';
      const list = state === 'all' ? found.repo.issues : found.repo.issues.filter((issue) => issue.state === state);
      return toolResult(list.map((issue) => issueJson(store, found.repo, issue)));
    }
    case 'create_pull_request': {
      const found = needRepo(store, args);
      if ('error' in found) return toolError(found.error);
      const repo = found.repo;
      const head = asString(args.head) as string;
      const base = asString(args.base) as string;
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) {
        return toolError('head or base branch does not exist');
      }
      const duplicate = repo.pulls.find((p) => p.head === head && p.base === base && p.state === 'open');
      if (duplicate !== undefined) return toolError('A pull request already exists for this head branch');
      const pull: PullRequest = {
        number: repo.nextNumber++,
        title: asString(args.title) as string,
        body: asString(args.body) ?? '',
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeSha: null,
        head,
        base,
        headSha,
        baseSha,
        seq: repo.pulls.length,
        createdSeq: repo.pulls.length,
      };
      repo.pulls.push(pull);
      return toolResult(pullJson(store, repo, pull));
    }
    case 'merge_pull_request': {
      const found = needRepo(store, args);
      if ('error' in found) return toolError(found.error);
      const number = asNumber(args.pull_number);
      const pull = number === null ? undefined : found.repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return toolError(`Pull request not found: #${String(args.pull_number)}`);
      const merged = squashMergePull(store, found.repo, pull);
      if (!merged.ok) return toolError(merged.reason ?? 'Cannot merge');
      return toolResult({ sha: merged.sha, merged: true, number: pull.number, message: 'Pull Request successfully merged' });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------- entry point

/** Handle one POST /mcp request. */
export async function handleMcp(store: Store, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  const auth = req.headers.authorization ?? '';
  const authed = token === '' || auth === `Bearer ${token}`;
  if (!authed) {
    sendJsonRpc(res, 401, null, { error: { code: -32000, message: 'Requires authentication' } });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJsonRpc(res, 400, null, { error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    sendJsonRpc(res, 400, null, { error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const id: string | number | null = typeof parsed.id === 'string' || typeof parsed.id === 'number' ? parsed.id : null;
  const params: Record<string, unknown> = isRecord(parsed.params) ? parsed.params : {};
  const method = parsed.method;

  // A notification (no id) is answered with 202 and no body.
  if (parsed.id === undefined) {
    if (method === 'notifications/initialized') {
      res.writeHead(202);
      res.end();
      return;
    }
    res.writeHead(202);
    res.end();
    return;
  }

  // The revision this request declares, in _meta or the transport header.
  const meta = isRecord(params._meta) ? params._meta : {};
  const declared =
    asString(meta['io.modelcontextprotocol/protocolVersion']) ??
    asString(meta.protocolVersion) ??
    asString(req.headers['mcp-protocol-version']);
  if (declared !== null && !SUPPORTED_REVISIONS.includes(declared)) {
    rpcError(res, id, -32022, `Unsupported protocol version: ${declared}`, { supported: SUPPORTED_REVISIONS });
    return;
  }

  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };

  switch (method) {
    case 'server/discover': {
      sendJsonRpc(res, 200, id, {
        result: {
          supportedVersions: SUPPORTED_REVISIONS,
          capabilities: { tools: {} },
          serverInfo,
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
        },
      });
      return;
    }
    case 'initialize': {
      const offered = asString(params.protocolVersion);
      const revision = offered !== null && SUPPORTED_REVISIONS.includes(offered) ? offered : CURRENT_REVISION;
      sendJsonRpc(res, 200, id, {
        result: {
          protocolVersion: revision,
          capabilities: { tools: {} },
          serverInfo,
        },
      });
      return;
    }
    case 'ping': {
      sendJsonRpc(res, 200, id, { result: {} });
      return;
    }
    case 'tools/list': {
      sendJsonRpc(res, 200, id, { result: { tools: TOOLS } });
      return;
    }
    case 'tools/call': {
      const toolName = asString(params.name);
      if (toolName === null) {
        rpcError(res, id, -32602, 'Invalid params: tools/call requires a tool name');
        return;
      }
      if (!TOOL_NAMES.has(toolName)) {
        rpcError(res, id, -32602, `Unknown tool: ${toolName}`);
        return;
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      const result = callTool(store, toolName, args);
      sendJsonRpc(res, 200, id, { result });
      return;
    }
    default: {
      rpcError(res, id, -32601, `Method not found: ${method}`);
    }
  }
}
