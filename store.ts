// The forge's store: git objects, packs, repositories, issues, pull requests.
//
// Everything lives in memory: the trial's data is small, the suite's checks are the
// only client, and an in-memory store is what makes the timed workloads fast. Nothing
// here reads a clock for data: commit timestamps come from a fixed epoch plus a
// monotonic counter, so two runs on the same instance produce the same objects.

import { createHash } from 'node:crypto';
import { inflateSync as zlibInflate, deflateSync as zlibDeflate } from 'node:zlib';

// ---------------------------------------------------------------- git objects

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
const SHA1_RE = /^[0-9a-f]{40}$/i;

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && SHA1_RE.test(value);
}

/** The git id of an object: sha1("<type> <len>\0" + data). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object's entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) break;
    const nul = data.indexOf(0, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(pos, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    pos = nul + 21;
  }
  return entries;
}

const TREE_SORT_KEY = (e: TreeEntry): string => (e.mode === '40000' ? `${e.name}/` : e.name);

/** Build a tree object from entries (sorted git's way). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = entries.slice().sort((a, b) => {
    const ka = TREE_SORT_KEY(a);
    const kb = TREE_SORT_KEY(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitParts {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object's fields. */
export function parseCommit(data: Buffer): CommitParts {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object. The message is stored verbatim (callers add a trailing newline). */
export function buildCommit(parts: CommitParts): Buffer {
  let head = `tree ${parts.tree}\n`;
  for (const parent of parts.parents) head += `parent ${parent}\n`;
  head += `author ${parts.author}\ncommitter ${parts.committer}\n`;
  return Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from('\n', 'utf8'), Buffer.from(parts.message, 'utf8')]);
}

// ---------------------------------------------------------------- packfiles

const PACK_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Read a pack object's size/type varint. Returns [type, size, nextPos]. */
function readPackHeader(buf: Buffer, pos: number): [number, number, number] {
  let byte = buf[pos] ?? 0;
  const type = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let next = pos + 1;
  while ((byte & 0x80) !== 0) {
    byte = buf[next] ?? 0;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    next += 1;
  }
  return [type, size, next];
}

/** Read a delta's base offset (OFS_DELTA): the offset back from the delta's position. */
function readOfsOffset(buf: Buffer, pos: number): [number, number] {
  let byte = buf[pos] ?? 0;
  let offset = byte & 0x7f;
  let next = pos + 1;
  while ((byte & 0x80) !== 0) {
    byte = buf[next] ?? 0;
    offset = ((offset + 1) << 7) | (byte & 0x7f);
    next += 1;
  }
  return [offset, next];
}

/** Read a delta size varint. */
function readDeltaVarint(buf: Buffer, pos: number): [number, number] {
  let value = 0;
  let shift = 0;
  let next = pos;
  for (;;) {
    const byte = buf[next] ?? 0;
    next += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return [value, next];
}

/** Apply a git delta to a base object, returning the result. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const [sourceSize, p1] = readDeltaVarint(delta, pos);
  pos = p1;
  const [targetSize, p2] = readDeltaVarint(delta, pos);
  pos = p2;
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos] ?? 0;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if ((op & (1 << i)) !== 0) { offset |= (delta[pos] ?? 0) << (8 * i); pos += 1; }
      for (let i = 0; i < 3; i += 1) if ((op & (0x10 << i)) !== 0) { size |= (delta[pos] ?? 0) << (8 * i); pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      outLen += op;
      pos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (outLen !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out, outLen);
}

/**
 * Parse a packfile into objects. `resolveBase` supplies objects already in the
 * repository (for REF_DELTA bases the pack does not carry). Deltas resolve against
 * objects parsed in this pack or via `resolveBase`, in pack order, with a fix-up
 * loop for bases that appear later in the pack.
 */
export function parsePack(buf: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = buf.readUInt32BE(8);
  const found = new Map<string, GitObject>();
  const byPos = new Map<number, GitObject>();
  interface DeltaRec { type: number; basePos?: number; baseOid?: string; data: Buffer; startPos: number }
  const deltas: DeltaRec[] = [];
  let pos = 12;
  for (let i = 0; i < count; i += 1) {
    const startPos = pos;
    const [type, size, afterHeader] = readPackHeader(buf, pos);
    if (type === 6) {
      const [offset, afterOfs] = readOfsOffset(buf, afterHeader);
      const consumed = zlibConsumed(buf.subarray(afterOfs));
      const inflated = zlibInflate(buf.subarray(afterOfs, afterOfs + consumed));
      if (inflated.length !== size) throw new Error('ofs-delta inflated size mismatch');
      deltas.push({ type, basePos: startPos - offset, data: inflated, startPos });
      pos = afterOfs + consumed;
    } else if (type === 7) {
      const baseOid = buf.subarray(afterHeader, afterHeader + 20).toString('hex');
      const consumed = zlibConsumed(buf.subarray(afterHeader + 20));
      const inflated = zlibInflate(buf.subarray(afterHeader + 20, afterHeader + 20 + consumed));
      if (inflated.length !== size) throw new Error('ref-delta inflated size mismatch');
      deltas.push({ type, baseOid, data: inflated, startPos });
      pos = afterHeader + 20 + consumed;
    } else {
      const objType = PACK_TYPES[type];
      if (objType === undefined) throw new Error(`unknown pack object type ${type}`);
      const consumed = zlibConsumed(buf.subarray(afterHeader));
      const data = zlibInflate(buf.subarray(afterHeader, afterHeader + consumed));
      if (data.length !== size) throw new Error('object inflated size mismatch');
      pos = afterHeader + consumed;
      const oid = hashObject(objType, data);
      const obj: GitObject = { type: objType, data };
      found.set(oid, obj);
      byPos.set(startPos, obj);
    }
  }
  // Resolve deltas in pack order, repeating while progress is made (a delta's base
  // may itself be a delta, and a REF_DELTA base may sit later in the pack).
  let pending = deltas;
  for (let round = 0; round < 8 && pending.length > 0; round += 1) {
    const next: DeltaRec[] = [];
    for (const d of pending) {
      let base: GitObject | undefined;
      if (d.type === 6) base = byPos.get(d.basePos ?? -1);
      else {
        const oid = d.baseOid ?? '';
        base = found.get(oid) ?? resolveBase?.(oid);
      }
      if (base === undefined) { next.push(d); continue; }
      const data = applyDelta(base.data, d.data);
      const oid = hashObject(base.type, data);
      const obj: GitObject = { type: base.type, data };
      found.set(oid, obj);
      byPos.set(d.startPos, obj);
    }
    if (next.length === pending.length) break;
    pending = next;
  }
  if (pending.length > 0) throw new Error('a pack delta base could not be resolved');
  return found;
}

/**
 * How many bytes of `buf` a zlib stream starting at its first byte consumes.
 * inflateSync ignores trailing bytes but throws on a truncated stream, so the
 * stream's end is the smallest prefix that inflates: binary search finds it.
 */
function zlibConsumed(buf: Buffer): number {
  let lo = 0;
  let hi = buf.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      zlibInflate(buf.subarray(0, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

/** Encode one full object into pack bytes (no deltas). */
function packObject(type: GitObjectType, data: Buffer): Buffer {
  const typeId = PACK_TYPE_IDS[type];
  // Varint header: first byte holds type in bits 4..6 and low 4 bits of size.
  const header: number[] = [];
  let size = data.length;
  let first = (typeId << 4) | (size & 0x0f);
  size >>>= 4;
  if (size > 0) first |= 0x80;
  header.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>>= 7;
    if (size > 0) byte |= 0x80;
    header.push(byte);
  }
  const deflated = zlibDeflate(data);
  return Buffer.concat([Buffer.from(header), deflated]);
}

/** Build a packfile from full objects (no deltas). */
export function buildPack(objects: readonly GitObject[]): Buffer {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  const parts: Buffer[] = [head];
  for (const obj of objects) parts.push(packObject(obj.type, obj.data));
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- the store

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  seq: number;
  comments: { id: number; body: string; seq: number }[];
  createdSeq: number;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  seq: number;
  createdSeq: number;
}

/** A flat file tree at a ref tip: path -> blob oid + mode. */
export type FlatTree = Map<string, { oid: string; mode: string }>;

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  flatTrees: Map<string, FlatTree>;
  labels: Map<string, Label>;
  issues: Issue[];
  pulls: PullRequest[];
  nextNumber: number;
  nextCommentId: number;
  seq: number;
}

const COMMIT_EPOCH_SEC = 1_735_689_600;

export class Store {
  readonly repos = new Map<string, Repo>();
  readonly viewerLogin: string;
  readonly viewerName: string;
  readonly viewerEmail: string;
  private nextRepoId = 1;
  private clockSeq = 0;

  constructor(viewerLogin: string, viewerName: string, viewerEmail: string) {
    this.viewerLogin = viewerLogin;
    this.viewerName = viewerName;
    this.viewerEmail = viewerEmail;
  }

  /** A deterministic timestamp for a new commit (seconds since the scenario epoch). */
  nextTimestamp(): number {
    this.clockSeq += 1;
    return COMMIT_EPOCH_SEC + this.clockSeq;
  }

  identity(): string {
    return `${this.viewerName} <${this.viewerEmail}> ${this.nextTimestamp()} +0000`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: this.viewerLogin,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      flatTrees: new Map(),
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentId: 1,
      seq: this.repos.size,
    };
    this.repos.set(this.repoKey(this.viewerLogin, name), repo);
    return repo;
  }

  /** The repo the token owner owns, or undefined (any other owner is a 404). */
  getRepo(owner: string, name: string): Repo | undefined {
    if (owner !== this.viewerLogin) return undefined;
    return this.repos.get(this.repoKey(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Build nested tree objects from a flat tree; returns the root tree oid. */
  buildTrees(repo: Repo, flat: FlatTree): string {
    const build = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, entry] of flat) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
        } else {
          dirs.add(rest.slice(0, slash));
        }
      }
      for (const dir of dirs) {
        entries.push({ mode: '40000', name: dir, oid: build(`${prefix}${dir}/`) });
      }
      const data = buildTree(entries);
      return this.putObject(repo, 'tree', data);
    };
    return build('');
  }

  /** The tree oid of a directory inside a flat tree ('' for the root). */
  dirTreeOid(repo: Repo, flat: FlatTree, dir: string): string {
    const prefix = dir === '' ? '' : `${dir.replace(/\/+$/, '')}/`;
    const build = (p: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Set<string>();
      for (const [path, entry] of flat) {
        if (!path.startsWith(p)) continue;
        const rest = path.slice(p.length);
        const slash = rest.indexOf('/');
        if (slash < 0) entries.push({ mode: entry.mode, name: rest, oid: entry.oid });
        else dirs.add(rest.slice(0, slash));
      }
      for (const d of dirs) entries.push({ mode: '40000', name: d, oid: build(`${p}${d}/`) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(prefix);
  }

  /**
   * Create a commit on `ref` with `changes` applied to its flat tree (a path set to
   * null removes it). Returns the new commit oid. `message` is stored with a trailing
   * newline, git's convention; REST strips it on read.
   */
  commitOnRef(repo: Repo, ref: string, changes: Map<string, { oid: string; mode: string } | null>, message: string): string {
    const parentOid = repo.refs.get(ref);
    const parentFlat = parentOid === undefined ? new Map<string, { oid: string; mode: string }>() : new Map(repo.flatTrees.get(ref) ?? new Map());
    const flat = new Map(parentFlat);
    for (const [path, change] of changes) {
      if (change === null) flat.delete(path);
      else flat.set(path, change);
    }
    const treeOid = this.buildTrees(repo, flat);
    const author = this.identity();
    const committer = author;
    const commit = buildCommit({
      tree: treeOid,
      parents: parentOid === undefined ? [] : [parentOid],
      author,
      committer,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    const commitOid = this.putObject(repo, 'commit', commit);
    repo.refs.set(ref, commitOid);
    repo.flatTrees.set(ref, flat);
    return commitOid;
  }

  /** Commits reachable from `tipOid`, newest first (by creation order). */
  commitsFrom(repo: Repo, tipOid: string): { oid: string; commit: CommitParts }[] {
    const out: { oid: string; commit: CommitParts; seq: number }[] = [];
    const seen = new Set<string>();
    const stack = [tipOid];
    const order = new Map<string, number>();
    let n = 0;
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const parsed = parseCommit(obj.data);
      order.set(oid, n++);
      out.push({ oid, commit: parsed, seq: order.get(oid) as number });
      for (const parent of parsed.parents) stack.push(parent);
    }
    // Newest first: reverse of discovery order is not reliable for merges; use the
    // commit's own timestamp, then discovery order as a tie-break.
    out.sort((a, b) => {
      const ta = commitTimestamp(a.commit);
      const tb = commitTimestamp(b.commit);
      if (ta !== tb) return tb - ta;
      return a.seq - b.seq;
    });
    return out.map(({ oid, commit }) => ({ oid, commit }));
  }

  /** Whether `ancestorOid` is reachable from `tipOid` (or equal to it). */
  isAncestor(repo: Repo, ancestorOid: string, tipOid: string): boolean {
    if (ancestorOid === tipOid) return true;
    const seen = new Set<string>();
    const stack = [tipOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === ancestorOid) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) stack.push(parent);
    }
    return false;
  }

  /** All objects reachable from `oids`, minus those reachable from `excludeOids`. */
  closure(repo: Repo, oids: readonly string[], excludeOids: readonly string[] = []): GitObject[] {
    const exclude = new Set<string>();
    const walkExclude = (start: string): void => {
      const stack = [start];
      while (stack.length > 0) {
        const oid = stack.pop() as string;
        if (exclude.has(oid)) continue;
        exclude.add(oid);
        const obj = repo.objects.get(oid);
        if (obj === undefined) continue;
        if (obj.type === 'commit') {
          const parsed = parseCommit(obj.data);
          stack.push(parsed.tree);
          for (const parent of parsed.parents) stack.push(parent);
        } else if (obj.type === 'tree') {
          for (const entry of parseTree(obj.data)) stack.push(entry.oid);
        }
      }
    };
    for (const oid of excludeOids) walkExclude(oid);
    const out = new Map<string, GitObject>();
    const stack = [...oids];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (exclude.has(oid) || out.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      out.set(oid, obj);
      if (obj.type === 'commit') {
        const parsed = parseCommit(obj.data);
        stack.push(parsed.tree);
        for (const parent of parsed.parents) stack.push(parent);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      }
    }
    return [...out.values()];
  }

  /** The flat tree at a ref, or undefined when the ref does not exist. */
  flatAt(repo: Repo, ref: string): FlatTree | undefined {
    return repo.flatTrees.get(ref);
  }

  /** Diff of flat trees: paths changed from `base` to `head`. */
  static diffFlat(base: FlatTree, head: FlatTree): { path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }[] {
    const out: { path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }[] = [];
    for (const [path, entry] of head) {
      const old = base.get(path);
      if (old === undefined) out.push({ path, status: 'added', oldOid: null, newOid: entry.oid });
      else if (old.oid !== entry.oid) out.push({ path, status: 'modified', oldOid: old.oid, newOid: entry.oid });
    }
    for (const [path] of base) {
      if (!head.has(path)) out.push({ path, status: 'removed', oldOid: base.get(path)?.oid ?? null, newOid: null });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }
}

/** The flat path -> blob map at an arbitrary commit (walks its tree from the object store). */
export function flatAtCommit(repo: Repo, commitOid: string): FlatTree {
  const flat: FlatTree = new Map();
  const obj = repo.objects.get(commitOid);
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

/** A commit's author/committer timestamp (seconds), or 0. */
export function commitTimestamp(commit: CommitParts): number {
  const line = commit.author !== '' ? commit.author : commit.committer;
  const match = /> (\d+) /.exec(line);
  return match !== null ? Number(match[1]) : 0;
}

/** The commit message as REST shows it: one trailing newline stripped. */
export function displayMessage(message: string): string {
  return message.endsWith('\n') ? message.slice(0, -1) : message;
}

/** Count added/removed lines between two texts (simple LCS on lines). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  // Drop a trailing empty element produced by a final newline.
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const n = oldLines.length;
  const m = newLines.length;
  // LCS lengths, O(n*m) with two rows; files here are small.
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      curr[j] = oldLines[i - 1] === newLines[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], curr[j - 1]);
    }
    [prev, curr] = [curr, prev];
  }
  const common = prev[m];
  return { additions: m - common, deletions: n - common };
}
