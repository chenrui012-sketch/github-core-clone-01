// git smart HTTP: upload-pack protocol v2 (v0 advertisement too) and receive-pack v0.
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack   v2 when the client
//          sends Git-Protocol: version=2, else the v0 advertisement
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack  v0 advertisement
//   POST /{owner}/{repo}.git/git-upload-pack                     v2 ls-refs / fetch
//   POST /{owner}/{repo}.git/git-receive-pack                    v0 push
//
// No auth on this surface (the conformance client sends none); a push cannot invent
// a repository, so a missing repo is 404 on every git route. Packs are sent as full
// objects (no deltas): the suite accepts that, and it keeps the hot path simple.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildPack,
  parseCommit,
  parsePack,
  parseTree,
  ZERO_OID,
  type FlatTree,
  type GitObject,
  type Repo,
  type Store,
} from './store.ts';

const AGENT = 'forge/1.0';
const ZERO = ZERO_OID;
const SIDEBAND_MAX = 65500; // pkt-line payload cap is 65516; stay comfortably under it

// ---------------------------------------------------------------- pkt-lines

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 0, 'ascii');
  return Buffer.concat([head, data]);
}

function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

function pktLines(lines: readonly (string | Buffer)[]): Buffer {
  return Buffer.concat(lines.map((line) => pktLine(line)));
}

interface Pkt {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/**
 * Parse a pkt-line stream. With stopAtFirstFlush (receive-pack) the bytes after
 * the first flush are returned as `trailing` (the pack); otherwise the whole
 * buffer must be pkt-lines (upload-pack: a v0 request has two flushed sections).
 */
function parsePktStream(buf: Buffer, stopAtFirstFlush = true): { packets: Pkt[]; trailing: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      throw new Error(`bad pkt-line header ${JSON.stringify(head)}`);
    }
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      if (stopAtFirstFlush) break;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) {
      throw new Error(`bad pkt-line length ${len}`);
    }
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, trailing: buf.subarray(offset) };
}

/** The data-packet lines of a receive-pack request, as strings (newline stripped). */
function requestLines(buf: Buffer): { lines: string[]; trailing: Buffer } {
  const { packets, trailing } = parsePktStream(buf, true);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    if (packet.kind === 'flush') break;
  }
  return { lines, trailing };
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

// ---------------------------------------------------------------- refs

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

function defaultBranchOid(repo: Repo): string | null {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

/** Peel an annotated tag to its target commit oid, or null for a lightweight tag. */
function peelTag(repo: Repo, oid: string): string | null {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return null;
  const text = obj.data.toString('utf8');
  const match = /^object ([0-9a-f]{40})$/m.exec(text);
  if (match === null) return null;
  const target = match[1];
  const targetObj = repo.objects.get(target);
  if (targetObj === undefined) return null;
  if (targetObj.type === 'commit') return target;
  if (targetObj.type === 'tag') return peelTag(repo, target);
  return null;
}

/** The flat path -> blob map at a commit tip, for the REST/GraphQL views of a pushed branch. */
function flatTreeAtTip(repo: Repo, tipOid: string): FlatTree {
  const flat: FlatTree = new Map();
  const obj = repo.objects.get(tipOid);
  if (obj === undefined || obj.type !== 'commit') return flat;
  const walk = (treeOid: string, prefix: string): void => {
    const treeObj = repo.objects.get(treeOid);
    if (treeObj === undefined || treeObj.type !== 'tree') return;
    for (const entry of parseTree(treeObj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else flat.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(parseCommit(obj.data).tree, '');
  return flat;
}

/** v0 ref advertisement lines: `<oid> <name>` plus `^{}` peeled lines for annotated tags. */
function v0RefLines(repo: Repo): string[] {
  const lines: string[] = [];
  for (const name of sortedRefNames(repo)) {
    const oid = repo.refs.get(name) as string;
    lines.push(`${oid} ${name}\n`);
    if (name.startsWith('refs/tags/')) {
      const peeled = peelTag(repo, oid);
      if (peeled !== null) lines.push(`${peeled} ${name}^{}\n`);
    }
  }
  return lines;
}

function uploadV0Caps(repo: Repo): string {
  return `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT}`;
}

const RECEIVE_CAPS =
  `report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta agent=${AGENT}`;

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const headOid = defaultBranchOid(repo) ?? ZERO;
  const caps = service === 'git-upload-pack' ? uploadV0Caps(repo) : RECEIVE_CAPS;
  const parts: Buffer[] = [
    pktLine(`# service=${service}\n`),
    pktFlush(),
    pktLine(`${headOid} HEAD\0${caps}\n`),
  ];
  for (const line of v0RefLines(repo)) parts.push(pktLine(line));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
  ];
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    ...lines.map((line) => pktLine(line)),
    pktFlush(),
  ]);
}

// ---------------------------------------------------------------- fetch selection

interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Which objects a fetch sends.
 *
 * wants: wanted oids (commits or annotated tags). haves: oids the client holds.
 * shallow: the client's current shallow boundaries. depth: deepen N, if given.
 *
 * Commits are included by BFS distance from the wants (depth caps the distance);
 * a commit the client holds is excluded, where "holds" follows parent edges from
 * a have but stops at a shallow boundary (the boundary itself and its tree are
 * held, its parents are not). Trees and blobs follow their commits, minus
 * anything reachable from the held commits. New shallow boundaries are the
 * included commits at distance depth-1; an old boundary whose parent is now
 * included becomes unshallow.
 */
function planFetch(repo: Repo, wants: string[], haves: string[], shallow: string[], depth: number | null): FetchPlan {
  const shallowSet = new Set(shallow);

  // Held commits: BFS from haves over parent edges, not expanding past a boundary.
  const held = new Set<string>();
  const heldQueue: string[] = [...haves];
  while (heldQueue.length > 0) {
    const oid = heldQueue.pop() as string;
    if (held.has(oid)) continue;
    held.add(oid);
    if (shallowSet.has(oid)) continue; // boundary: parents are not held
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) heldQueue.push(parent);
  }

  // Included commits with their BFS distance from the wants; tags are transparent.
  const distance = new Map<string, number>();
  const tagObjects: Array<{ oid: string; obj: GitObject }> = [];
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      tagObjects.push({ oid: want, obj });
      const target = peelTag(repo, want);
      if (target !== null) queue.push({ oid: target, dist: 0 });
      continue;
    }
    if (obj.type === 'commit') queue.push({ oid: want, dist: 0 });
  }
  while (queue.length > 0) {
    const { oid, dist } = queue.shift() as { oid: string; dist: number };
    if (distance.has(oid)) continue;
    if (depth !== null && dist >= depth) continue;
    distance.set(oid, dist);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) {
      if (!distance.has(parent)) queue.push({ oid: parent, dist: dist + 1 });
    }
  }

  // Objects reachable from the held commits. A shallow boundary contributes its
  // own tree but not its parents (the client holds the boundary's files, not its
  // history).
  const heldObjects = new Set<string>();
  const heldStack = [...held];
  while (heldStack.length > 0) {
    const oid = heldStack.pop() as string;
    if (heldObjects.has(oid)) continue;
    heldObjects.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      const parsed = parseCommit(obj.data);
      heldStack.push(parsed.tree);
      if (!shallowSet.has(oid)) {
        for (const parent of parsed.parents) heldStack.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) heldStack.push(entry.oid);
    } else if (obj.type === 'tag') {
      const target = peelTag(repo, oid);
      if (target !== null) heldStack.push(target);
    }
  }

  // Walk the included commits' trees; skip anything already held.
  const out = new Map<string, GitObject>();
  for (const { oid, obj } of tagObjects) {
    if (!heldObjects.has(oid)) out.set(oid, obj);
  }
  const walkStack: string[] = [];
  for (const oid of distance.keys()) {
    if (held.has(oid)) continue;
    walkStack.push(oid);
  }
  while (walkStack.length > 0) {
    const oid = walkStack.pop() as string;
    if (heldObjects.has(oid) || out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      walkStack.push(parseCommit(obj.data).tree);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) walkStack.push(entry.oid);
    }
  }

  // Shallow bookkeeping.
  const newShallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const [oid, dist] of distance) {
      if (dist === depth - 1 && !held.has(oid)) newShallow.push(oid);
    }
  }
  for (const boundary of shallow) {
    const obj = repo.objects.get(boundary);
    if (obj === undefined || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    const deepened = parents.some((parent) => distance.has(parent) && !held.has(parent));
    if (deepened) unshallow.push(boundary);
    else if (depth !== null && !newShallow.includes(boundary)) newShallow.push(boundary);
  }
  return { objects: [...out.values()], shallow: newShallow, unshallow };
}

// ---------------------------------------------------------------- upload-pack

function sidebandPackets(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_MAX) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_MAX));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) parts.push(pktLine(Buffer.from([1])));
  return parts;
}

function wantedRefsLines(repo: Repo, wants: string[]): string[] {
  const wantSet = new Set(wants);
  const lines: string[] = [];
  for (const name of sortedRefNames(repo)) {
    const oid = repo.refs.get(name) as string;
    if (wantSet.has(oid)) lines.push(`${oid} ${name}\n`);
  }
  return lines;
}

function parseFetchArgs(lines: string[]): { wants: string[]; haves: string[]; shallow: string[]; depth: number | null } {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0].trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  return { wants, haves, shallow, depth };
}

function handleFetchV2(repo: Repo, lines: string[]): Buffer {
  const { wants, haves, shallow, depth } = parseFetchArgs(lines);
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = buildPack(plan.objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim());
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  const wanted = wantedRefsLines(repo, wants);
  if (wanted.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const line of wanted) parts.push(pktLine(line));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, lines: string[]): Buffer {
  const { wants, haves, shallow, depth } = parseFetchArgs(lines);
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = buildPack(plan.objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleLsRefs(repo: Repo, lines: string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  for (const line of lines) {
    if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11).trim());
    else if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
  }
  const headOid = defaultBranchOid(repo);
  const out: string[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (prefixes.length === 0) {
    const target = ` symref-target:refs/heads/${repo.defaultBranch}`;
    if (headOid !== null) out.push(`${headOid} HEAD${symrefs ? target : ''}\n`);
    else out.push(`unborn HEAD${symrefs ? target : ''}\n`);
  }
  for (const name of sortedRefNames(repo)) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (peel && name.startsWith('refs/tags/')) {
      const peeled = peelTag(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    out.push(`${line}\n`);
  }
  return Buffer.concat([...out.map((line) => pktLine(line)), pktFlush()]);
}

function handleUploadPack(repo: Repo, body: Buffer): Buffer {
  const { packets } = parsePktStream(body, false);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const commandLine = lines.find((line) => line.startsWith('command='));
  const command = commandLine === undefined ? '' : commandLine.slice('command='.length);
  if (command === 'ls-refs') return handleLsRefs(repo, lines);
  if (command === 'fetch') return handleFetchV2(repo, lines);
  if (command === '') return handleFetchV0(repo, lines); // no v2 command: a v0 fetch
  throw new Error(`unknown upload-pack command ${JSON.stringify(command)}`);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { lines, trailing } = requestLines(body);
  const commands: PushCommand[] = [];
  let sideband = false;
  for (const line of lines) {
    const nul = line.indexOf('\0');
    const head = nul >= 0 ? line.slice(0, nul) : line;
    if (nul >= 0) {
      const caps = line.slice(nul + 1).split(' ');
      sideband = caps.includes('side-band-64k');
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(head);
    if (match === null) throw new Error(`bad receive-pack command ${JSON.stringify(head.slice(0, 60))}`);
    commands.push({ oldOid: match[1], newOid: match[2], ref: match[3] });
  }
  if (commands.length === 0) throw new Error('empty receive-pack command list');

  // Unpack first: every object lands in the store even when a ref update is refused.
  let unpackError: string | null = null;
  if (trailing.length > 0) {
    try {
      const objects = parsePack(trailing, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack error';
    }
  }

  const report: string[] = [];
  if (unpackError !== null) {
    report.push(`unpack ${unpackError}\n`);
  } else {
    report.push('unpack ok\n');
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO) {
        // Delete.
        if (current === undefined) {
          report.push(`ng ${command.ref} remote ref does not exist\n`);
        } else if (command.oldOid !== ZERO && command.oldOid !== current) {
          report.push(`ng ${command.ref} stale info\n`);
        } else {
          repo.refs.delete(command.ref);
          repo.flatTrees.delete(command.ref);
          report.push(`ok ${command.ref}\n`);
        }
        continue;
      }
      if (current === undefined) {
        if (command.oldOid !== ZERO) {
          report.push(`ng ${command.ref} remote ref does not exist\n`);
          continue;
        }
        if (!repo.objects.has(command.newOid)) {
          report.push(`ng ${command.ref} object not found\n`);
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        if (command.ref.startsWith('refs/heads/')) {
          repo.flatTrees.set(command.ref, flatTreeAtTip(repo, command.newOid));
        }
        report.push(`ok ${command.ref}\n`);
        continue;
      }
      if (command.oldOid !== current) {
        report.push(`ng ${command.ref} stale info\n`);
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        report.push(`ng ${command.ref} object not found\n`);
        continue;
      }
      if (command.ref.startsWith('refs/heads/') && !isAncestorOf(repo, current, command.newOid)) {
        report.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      if (command.ref.startsWith('refs/heads/')) {
        repo.flatTrees.set(command.ref, flatTreeAtTip(repo, command.newOid));
      }
      report.push(`ok ${command.ref}\n`);
    }
  }

  const reportBody = pktLines(report);
  if (sideband) {
    return Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), reportBody])), pktFlush()]);
  }
  return Buffer.concat([reportBody, pktFlush()]);
}

/** Whether `ancestor` is reachable from `tip` (or equal to it); tags peel first. */
function isAncestorOf(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    } else if (obj.type === 'tag') {
      const target = peelTag(repo, oid);
      if (target !== null) stack.push(target);
    }
  }
  return false;
}

// ---------------------------------------------------------------- entry point

/** Route a git smart-HTTP request. `subpath` is the part after `{owner}/{repo}.git`. */
export async function handleGit(
  store: Store,
  _token: string,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  repoName: string,
  subpath: string,
  query: URLSearchParams,
  _authed: boolean,
): Promise<void> {
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    send(res, 404, 'text/plain; charset=utf-8', Buffer.from('repository not found\n', 'utf8'));
    return;
  }
  const method = req.method ?? 'GET';
  try {
    if (method === 'GET' && subpath === '/info/refs') {
      const service = query.get('service');
      if (service === 'git-upload-pack') {
        const v2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        send(res, 200, 'application/x-git-upload-pack-advertisement', v2 ? v2Advertisement() : v0Advertisement('git-upload-pack', repo));
        return;
      }
      if (service === 'git-receive-pack') {
        send(res, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement('git-receive-pack', repo));
        return;
      }
      send(res, 400, 'text/plain; charset=utf-8', Buffer.from('unknown service\n', 'utf8'));
      return;
    }
    if (method === 'POST' && subpath === '/git-upload-pack') {
      const body = await readBody(req);
      send(res, 200, 'application/x-git-upload-pack-result', handleUploadPack(repo, body));
      return;
    }
    if (method === 'POST' && subpath === '/git-receive-pack') {
      const body = await readBody(req);
      send(res, 200, 'application/x-git-receive-pack-result', handleReceivePack(repo, body));
      return;
    }
    send(res, 404, 'text/plain; charset=utf-8', Buffer.from('not found\n', 'utf8'));
  } catch (err) {
    // A malformed pkt-line stream (or any other bad input) is a 400, never a crash:
    // the suite probes this and then keeps cloning the same repo.
    if (!res.headersSent) {
      send(res, 400, 'text/plain; charset=utf-8', Buffer.from(`bad request: ${err instanceof Error ? err.message : 'unknown'}\n`, 'utf8'));
    } else {
      res.destroy();
    }
  }
}
