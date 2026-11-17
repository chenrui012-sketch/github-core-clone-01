// The REST v3 API (/api/v3), as the suite's checks drive it.
//
// Every reply is application/json with a non-empty X-GitHub-Request-Id; errors carry
// {"message": string}. Auth is one bearer token (MAKEFUN_SHOP_TOKEN): a request
// without it, or with a wrong one, is 401. A repository belongs to the token owner,
// so the same name under another owner is 404, never 403.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Store,
  displayMessage,
  flatAtCommit,
  lineDiff,
  type FlatTree,
  type Issue,
  type Label,
  type PullRequest,
  type Repo,
} from './store.ts';

export interface RestDeps {
  store: Store;
  token: string;
}

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendNoContent(res: ServerResponse, status: number): void {
  res.writeHead(status, { 'x-github-request-id': requestId() });
  res.end();
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Parse a JSON body; returns null and answers 400 when it is not JSON. */
export async function readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | null> {
  const raw = await readBody(req);
  if (raw.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  } catch {
    sendError(res, 400, 'Problems parsing JSON');
    return null;
  }
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000 },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    html_url: `/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

/** An opaque, stable global id: base64 of a typed key (never the bare numeric id). */
export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: store.viewerLogin, id: 1000 },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    comments: issue.comments.length,
  };
}

export function pullJson(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + pull.number,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.head, sha: pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    user: { login: store.viewerLogin, id: 1000 },
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
  };
}

/**
 * Squash-merge an open, non-conflicted pull request onto its base branch: one
 * commit on the base branch with the head's tree. Shared by the REST merge
 * route and the MCP merge_pull_request tool so both see the same result.
 * Returns `{ ok: true, sha }`, or `{ ok: false, reason }` when the PR is
 * already closed or would conflict.
 */
export function squashMergePull(
  store: Store,
  repo: Repo,
  pull: PullRequest,
): { ok: boolean; sha?: string; reason?: string } {
  if (pull.state === 'closed') return { ok: false, reason: 'Pull request is already closed' };
  if (pullConflicts(store, repo, pull)) return { ok: false, reason: 'Merge conflict' };
  const headFlat = repo.flatTrees.get(`refs/heads/${pull.head}`) ?? flatAtCommit(repo, repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha);
  const baseRef = `refs/heads/${pull.base}`;
  const changes = new Map<string, { oid: string; mode: string } | null>();
  const currentFlat = repo.flatTrees.get(baseRef) ?? flatAtCommit(repo, repo.refs.get(baseRef) ?? pull.baseSha);
  for (const [path, entry] of headFlat) changes.set(path, entry);
  for (const [path] of currentFlat) if (!headFlat.has(path)) changes.set(path, null);
  const mergeSha = store.commitOnRef(repo, baseRef, changes, `Merge pull request #${pull.number} from ${pull.head}`);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = '2025-01-01T00:00:00Z';
  pull.mergeSha = mergeSha;
  return { ok: true, sha: mergeSha };
}
export function pullConflicts(store: Store, repo: Repo, pull: PullRequest): boolean {
  // Three-way check against the merge base (the base tip when the PR was created),
  // not the current base tip: after another PR merges, the current tip has moved.
  const baseFlat = flatAtCommit(repo, pull.baseSha);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const headFlat = flatAtCommit(repo, headTip);
  const tipOid = repo.refs.get(`refs/heads/${pull.base}`);
  if (tipOid === undefined) return false;
  const tipFlat = flatAtCommit(repo, tipOid);
  for (const change of Store.diffFlat(baseFlat, headFlat)) {
    const baseEntry = baseFlat.get(change.path);
    const tipEntry = tipFlat.get(change.path);
    if (change.status === 'removed') {
      // Head deleted a path the tip modified.
      if (tipEntry !== undefined && baseEntry !== undefined && tipEntry.oid !== baseEntry.oid) return true;
      continue;
    }
    if (tipEntry === undefined) continue; // tip removed it: handled by the second loop
    if (baseEntry !== undefined && tipEntry.oid !== baseEntry.oid && tipEntry.oid !== change.newOid) return true;
    if (baseEntry === undefined && tipEntry.oid !== change.newOid) return true;
  }
  for (const change of Store.diffFlat(baseFlat, tipFlat)) {
    // Tip deleted a path the head modified.
    if (change.status !== 'removed') continue;
    const headEntry = headFlat.get(change.path);
    const baseEntry = baseFlat.get(change.path);
    if (headEntry !== undefined && baseEntry !== undefined && headEntry.oid !== baseEntry.oid) return true;
  }
  return false;
}

/** The files a pull request changes (base -> head), with line counts. */
function pullFiles(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown>[] {
  const baseFlat = flatAtCommit(repo, pull.baseSha);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  const headFlat = flatAtCommit(repo, headTip);
  const out: Record<string, unknown>[] = [];
  for (const change of Store.diffFlat(baseFlat, headFlat)) {
    const oldText = change.oldOid === null ? '' : (repo.objects.get(change.oldOid)?.data.toString('utf8') ?? '');
    const newText = change.newOid === null ? '' : (repo.objects.get(change.newOid)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiff(oldText, newText);
    const status = change.status === 'added' ? 'added' : change.status === 'modified' ? 'modified' : 'removed';
    out.push({
      filename: change.path,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      sha: change.newOid ?? change.oldOid ?? '',
    });
  }
  return out;
}

function parsePagination(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number(query.get('per_page') ?? '30');
  const pageRaw = Number(query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  return { perPage, page };
}

function linkHeader(origin: string, path: string, query: URLSearchParams, perPage: number, page: number, hasNext: boolean): Record<string, string> {
  if (!hasNext) return {};
  const next = new URLSearchParams(query);
  next.set('per_page', String(perPage));
  next.set('page', String(page + 1));
  return { link: `<${origin}${path}?${next.toString()}>; rel="next"` };
}

function authOf(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${token}`;
}

interface Route {
  method: string;
  pattern: RegExp;
  handler: (req: IncomingMessage, res: ServerResponse, match: RegExpMatchArray, query: URLSearchParams) => Promise<void> | void;
}

/** Build the REST router for one store. `originOf` gives the request's origin for Link headers. */
export function createRestRouter(deps: RestDeps, originOf: (req: IncomingMessage) => string): Route[] {
  const { store, token } = deps;

  const needRepo = (res: ServerResponse, owner: string, name: string): Repo | null => {
    const repo = store.getRepo(owner, name);
    if (repo === undefined) {
      sendError(res, 404, 'Not Found');
      return null;
    }
    return repo;
  };

  const routes: Route[] = [
    {
      method: 'GET',
      pattern: /^\/api\/v3\/?$/,
      handler: (_req, res) => {
        sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/v3\/meta$/,
      handler: (_req, res) => {
        sendJson(res, 200, { installed_version: '1.0.0' });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/v3\/user\/repos$/,
      handler: (req, res, _m, query) => {
        const { perPage, page } = parsePagination(query);
        const all = store.listRepos();
        const slice = all.slice((page - 1) * perPage, page * perPage);
        const hasNext = page * perPage < all.length;
        sendJson(res, 200, slice.map((repo) => repoJson(store, repo)), linkHeader(originOf(req), '/api/v3/user/repos', query, perPage, page, hasNext));
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v3\/user\/repos$/,
      handler: async (req, res) => {
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const name = typeof body.name === 'string' && body.name !== '' ? body.name : null;
        if (name === null) {
          sendError(res, 422, 'name is required');
          return;
        }
        const existing = store.getRepo(store.viewerLogin, name);
        if (existing !== undefined) {
          sendError(res, 422, 'Repository already exists.');
          return;
        }
        const repo = store.createRepo(name, body.private === true, typeof body.description === 'string' ? body.description : '');
        sendJson(res, 201, repoJson(store, repo));
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/,
      handler: (_req, res, m) => {
        const repo = needRepo(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (repo === null) return;
        sendJson(res, 200, repoJson(store, repo));
      },
    },
    {
      method: 'PATCH',
      pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/,
      handler: async (req, res, m) => {
        const repo = needRepo(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (repo === null) return;
        const body = await readJsonBody(req, res);
        if (body === null) return;
        if (typeof body.description === 'string') repo.description = body.description;
        sendJson(res, 200, repoJson(store, repo));
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)$/,
      handler: async (req, res, m) => {
        const repo = needRepo(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (repo === null) return;
        await readBody(req);
        store.repos.delete(store.repoKey(repo.owner, repo.name));
        sendNoContent(res, 204);
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/branches$/,
      handler: (_req, res, m) => {
        const repo = needRepo(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (repo === null) return;
        const out: Record<string, unknown>[] = [];
        for (const [ref, oid] of repo.refs) {
          if (!ref.startsWith('refs/heads/')) continue;
          out.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } });
        }
        sendJson(res, 200, out);
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/commits$/,
      handler: (_req, res, m, query) => {
        const repo = needRepo(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (repo === null) return;
        const refParam = query.get('sha');
        const refName = refParam === null ? `refs/heads/${repo.defaultBranch}` : refParam.startsWith('refs/') ? refParam : `refs/heads/${refParam}`;
        const tip = repo.refs.get(refName);
        if (tip === undefined) {
          sendJson(res, 200, []);
          return;
        }
        const commits = store.commitsFrom(repo, tip).map(({ oid, commit }) => ({
          sha: oid,
          commit: { message: displayMessage(commit.message), author: { name: store.viewerName, email: store.viewerEmail } },
        }));
        sendJson(res, 200, commits);
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/git\/refs$/,
      handler: async (req, res, m) => {
        const repo = needRepo(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (repo === null) return;
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
          sendError(res, 422, 'Invalid ref or sha');
          return;
        }
        repo.refs.set(ref, sha);
        if (ref.startsWith('refs/heads/')) {
          // A new branch starts from the flat tree of the ref the sha belongs to.
          if (!repo.flatTrees.has(ref)) {
            const donor = [...repo.refs.entries()].find(([r, o]) => o === sha && r !== ref)?.[0];
            const donorFlat = donor !== undefined ? repo.flatTrees.get(donor) : undefined;
            repo.flatTrees.set(ref, donorFlat === undefined ? new Map() : new Map(donorFlat));
          }
        }
        sendJson(res, 201, { ref, object: { sha } });
      },
    },
    {
      method: 'PUT',
      pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/,
      handler: async (req, res, m, query) => {
        const repo = needRepo(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (repo === null) return;
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const path = m[3].split('/').map((s) => decodeURIComponent(s)).join('/');
        const branchParam = typeof body.branch === 'string' ? body.branch : query.get('branch');
        const branch = branchParam ?? repo.defaultBranch;
        const ref = `refs/heads/${branch}`;
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        let content: Buffer;
        try {
          content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
        } catch {
          sendError(res, 400, 'content is not valid base64');
          return;
        }
        const message = typeof body.message === 'string' ? body.message : 'Update file';
        const flat = repo.flatTrees.get(ref);
        const existing = flat?.get(path);
        const isUpdate = existing !== undefined;
        if (typeof body.sha === 'string' && body.sha !== '') {
          if (!isUpdate || body.sha.toLowerCase() !== existing.oid.toLowerCase()) {
            sendError(res, 409, 'sha does not match the current blob');
            return;
          }
        }
        const blobOid = store.putObject(repo, 'blob', content);
        const commitOid = store.commitOnRef(repo, ref, new Map([[path, { oid: blobOid, mode: '100644' }]]), message);
        sendJson(res, isUpdate ? 200 : 201, {
          content: { sha: blobOid, encoding: 'base64', size: content.length, name: path.split('/').pop() ?? path, path },
          commit: { sha: commitOid },
        });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents(?:\/(.*))?$/,
      handler: (_req, res, m, query) => {
        const repo = needRepo(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (repo === null) return;
        const rawPath = m[3] ?? '';
        const path = rawPath === '' ? '' : rawPath.split('/').map((s) => decodeURIComponent(s)).join('/');
        const refParam = query.get('ref');
        const branch = refParam ?? repo.defaultBranch;
        const ref = refParam !== null && refParam.startsWith('refs/') ? refParam : `refs/heads/${branch}`;
        const flat = repo.flatTrees.get(ref);
        if (flat === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const file = path === '' ? undefined : flat.get(path);
        if (file !== undefined) {
          const data = repo.objects.get(file.oid)?.data ?? Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            content: data.toString('base64'),
            sha: file.oid,
            size: data.length,
            name: path.split('/').pop() ?? path,
            path,
          });
          return;
        }
        // Directory listing: direct children of `path`.
        const prefix = path === '' ? '' : `${path.replace(/\/+$/, '')}/`;
        const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
        for (const [p, entry] of flat) {
          if (!p.startsWith(prefix)) continue;
          const rest = p.slice(prefix.length);
          if (rest === '') continue;
          const slash = rest.indexOf('/');
          if (slash < 0) {
            children.set(rest, { type: 'file', name: rest, path: p, sha: entry.oid });
          } else {
            const dirName = rest.slice(0, slash);
            if (!children.has(dirName)) {
              const dirPath = `${prefix}${dirName}`;
              children.set(dirName, { type: 'dir', name: dirName, path: dirPath, sha: store.dirTreeOid(repo, flat, dirPath) });
            }
          }
        }
        if (children.size === 0) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)));
      },
    },
    {
      method: 'DELETE',
      pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/,
      handler: async (req, res, m, query) => {
        const repo = needRepo(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (repo === null) return;
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const path = m[3].split('/').map((s) => decodeURIComponent(s)).join('/');
        const branchParam = typeof body.branch === 'string' ? body.branch : query.get('branch');
        const branch = branchParam ?? repo.defaultBranch;
        const ref = `refs/heads/${branch}`;
        const flat = repo.flatTrees.get(ref);
        if (flat === undefined || !flat.has(path)) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const message = typeof body.message === 'string' ? body.message : 'Delete file';
        const commitOid = store.commitOnRef(repo, ref, new Map([[path, null]]), message);
        sendJson(res, 200, { commit: { sha: commitOid } });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/labels$/,
      handler: async (req, res, m) => {
        const repo = needRepo(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (repo === null) return;
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const name = typeof body.name === 'string' && body.name !== '' ? body.name : null;
        if (name === null) {
          sendError(res, 422, 'name is required');
          return;
        }
        const color = typeof body.color === 'string' ? body.color : 'ededed';
        const label: Label = { name, color };
        repo.labels.set(name, label);
        sendJson(res, 201, { name, color });
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/,
      handler: async (req, res, m) => {
        const repo = needRepo(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (repo === null) return;
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const title = typeof body.title === 'string' ? body.title : '';
        const issueBody = typeof body.body === 'string' ? body.body : '';
        const labelNames: string[] = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
        const labels: Label[] = [];
        for (const labelName of labelNames) {
          const label = repo.labels.get(labelName);
          if (label === undefined) {
            sendError(res, 422, `Label does not exist: ${labelName}`);
            return;
          }
          labels.push(label);
        }
        const issue: Issue = {
          number: repo.nextNumber++,
          title,
          body: issueBody,
          state: 'open',
          labels,
          seq: repo.issues.length,
          comments: [],
          createdSeq: repo.issues.length,
        };
        repo.issues.push(issue);
        sendJson(res, 201, issueJson(store, repo, issue));
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues$/,
      handler: (req, res, m, query) => {
        const repo = needRepo(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (repo === null) return;
        const { perPage, page } = parsePagination(query);
        let list = repo.issues.slice();
        const state = query.get('state');
        if (state === 'open' || state === 'closed') list = list.filter((issue) => issue.state === state);
        const direction = query.get('direction') ?? 'desc';
        const sort = query.get('sort') ?? 'created';
        if (sort === 'created') {
          list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        }
        const slice = list.slice((page - 1) * perPage, page * perPage);
        const hasNext = page * perPage < list.length;
        sendJson(res, 200, slice.map((issue) => issueJson(store, repo, issue)), linkHeader(originOf(req), `/api/v3/repos/${repo.owner}/${repo.name}/issues`, query, perPage, page, hasNext));
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/,
      handler: (_req, res, m) => {
        const repo = needRepo(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (repo === null) return;
        const issue = repo.issues.find((i) => i.number === Number(m[3]));
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, issueJson(store, repo, issue));
      },
    },
    {
      method: 'PATCH',
      pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/,
      handler: async (req, res, m) => {
        const repo = needRepo(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (repo === null) return;
        const issue = repo.issues.find((i) => i.number === Number(m[3]));
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const body = await readJsonBody(req, res);
        if (body === null) return;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        sendJson(res, 200, issueJson(store, repo, issue));
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/,
      handler: async (req, res, m) => {
        const repo = needRepo(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (repo === null) return;
        const issue = repo.issues.find((i) => i.number === Number(m[3]));
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const commentBody = typeof body.body === 'string' ? body.body : '';
        const comment = { id: repo.nextCommentId++, body: commentBody, seq: issue.comments.length };
        issue.comments.push(comment);
        sendJson(res, 201, { id: comment.id, body: comment.body });
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/,
      handler: (_req, res, m) => {
        const repo = needRepo(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (repo === null) return;
        const issue = repo.issues.find((i) => i.number === Number(m[3]));
        if (issue === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, body: c.body })));
      },
    },
    {
      method: 'POST',
      pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/,
      handler: async (req, res, m) => {
        const repo = needRepo(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (repo === null) return;
        const body = await readJsonBody(req, res);
        if (body === null) return;
        const head = typeof body.head === 'string' ? body.head : '';
        const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
        const title = typeof body.title === 'string' ? body.title : '';
        const pullBody = typeof body.body === 'string' ? body.body : '';
        const headRef = `refs/heads/${head}`;
        const baseRef = `refs/heads/${base}`;
        const headSha = repo.refs.get(headRef);
        const baseSha = repo.refs.get(baseRef);
        if (headSha === undefined || baseSha === undefined) {
          sendError(res, 422, 'head or base branch does not exist');
          return;
        }
        const duplicate = repo.pulls.find((p) => p.head === head && p.base === base && p.state === 'open');
        if (duplicate !== undefined) {
          sendError(res, 422, 'A pull request already exists for this head branch');
          return;
        }
        const pull: PullRequest = {
          number: repo.nextNumber++,
          title,
          body: pullBody,
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
        sendJson(res, 201, pullJson(store, repo, pull));
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls$/,
      handler: (req, res, m, query) => {
        const repo = needRepo(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (repo === null) return;
        const { perPage, page } = parsePagination(query);
        const state = query.get('state') ?? 'open';
        let list = repo.pulls.slice();
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, b) => b.createdSeq - a.createdSeq);
        const slice = list.slice((page - 1) * perPage, page * perPage);
        const hasNext = page * perPage < list.length;
        sendJson(res, 200, slice.map((p) => pullJson(store, repo, p)), linkHeader(originOf(req), `/api/v3/repos/${repo.owner}/${repo.name}/pulls`, query, perPage, page, hasNext));
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/,
      handler: (_req, res, m) => {
        const repo = needRepo(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (repo === null) return;
        const pull = repo.pulls.find((p) => p.number === Number(m[3]));
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, pullJson(store, repo, pull));
      },
    },
    {
      method: 'GET',
      pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/files$/,
      handler: (_req, res, m) => {
        const repo = needRepo(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (repo === null) return;
        const pull = repo.pulls.find((p) => p.number === Number(m[3]));
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, pullFiles(store, repo, pull));
      },
    },
    {
      method: 'PUT',
      pattern: /^\/api\/v3\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)\/merge$/,
      handler: async (req, res, m) => {
        const repo = needRepo(res, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (repo === null) return;
        const pull = repo.pulls.find((p) => p.number === Number(m[3]));
        if (pull === undefined) {
          sendError(res, 404, 'Not Found');
          return;
        }
        await readJsonBody(req, res).catch(() => null);
        const merged = squashMergePull(store, repo, pull);
        if (!merged.ok) {
          sendError(res, 405, merged.reason ?? 'Cannot merge');
          return;
        }
        sendJson(res, 200, { sha: merged.sha, merged: true, message: 'Pull Request successfully merged' });
      },
    },
  ];

  return routes;
}

/** Dispatch one request through the REST routes. Returns true when handled. */
/**
 * Route lookup cache: the timed workloads repeat one path thousands of times,
 * so remember which route a `METHOD path` matched. The cache stores the index
 * of the FIRST route the linear scan would find, so a hit is exactly equivalent
 * to scanning; a miss scans and records. Bounded (FIFO eviction) so a long run
 * cannot grow it without limit.
 */
const ROUTE_CACHE = new Map<string, number>();
const ROUTE_CACHE_MAX = 512;

export async function handleRest(
  routes: Route[],
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  query: URLSearchParams,
  authed: boolean,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const cacheKey = `${method} ${pathname}`;
  const cached = ROUTE_CACHE.get(cacheKey);
  if (cached !== undefined && cached < routes.length) {
    const route = routes[cached] as Route;
    const match = route.pattern.exec(pathname);
    if (match !== null) {
      if (!authed) {
        sendError(res, 401, 'Requires authentication');
        return true;
      }
      await route.handler(req, res, match, query);
      return true;
    }
    ROUTE_CACHE.delete(cacheKey);
  }
  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index] as Route;
    if (route.method !== method) continue;
    const match = route.pattern.exec(pathname);
    if (match === null) continue;
    if (ROUTE_CACHE.size >= ROUTE_CACHE_MAX) {
      const first = ROUTE_CACHE.keys().next();
      if (!first.done) ROUTE_CACHE.delete(first.value);
    }
    ROUTE_CACHE.set(cacheKey, index);
    if (!authed) {
      sendError(res, 401, 'Requires authentication');
      return true;
    }
    await route.handler(req, res, match, query);
    return true;
  }
  return false;
}

export function isAuthed(req: IncomingMessage, token: string): boolean {
  return authOf(req, token);
}
