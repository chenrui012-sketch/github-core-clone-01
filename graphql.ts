// GraphQL v4 at POST /api/graphql, for the documents gh and github-mcp-server send.
//
// A compact parser + executor for the suite's 18 documents (no general GraphQL
// library; the standard library has none). Unknown fields answer HTTP 200 with an
// errors array naming the field; an unknown repository is data.repository = null
// with no errors; an unauthenticated request is exactly 401. Mutations act on the
// same store as REST, and global ids are the opaque base64 ids rest.ts issues.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { globalId, pullConflicts, readBody } from './rest.ts';
import { Store, type Issue, type PullRequest, type Repo } from './store.ts';

// ---------------------------------------------------------------- tokenizer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'punct'; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) { out += src[j + 1]; j += 2; }
        else { out += src[j]; j += 1; }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (ch === '.' && src.slice(i, i + 3) === '...') { tokens.push({ kind: 'punct', value: '...' }); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(ch)) { tokens.push({ kind: 'punct', value: ch }); i += 1; continue; }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'int', value: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------- AST

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; type: string; selection: SelectionNode[] };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, unknown>;
  selection: SelectionNode[];
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first?.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      type = this.next().value as 'query' | 'mutation';
    }
    let name: string | null = null;
    const maybeName = this.peek();
    if (maybeName?.kind === 'name') name = this.next().value;
    // Variable definitions: ($x: Type, ...) — parse and skip the types.
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const token = this.next();
        if (token.kind === 'punct' && token.value === '$') this.next(); // variable name
        // Skip the type tokens until ',' or ')'.
        while (true) {
          const t = this.peek();
          if (t === undefined) throw new Error('unterminated variable definitions');
          if (t.kind === 'punct' && (t.value === ',' || t.value === ')')) break;
          if (t.kind === 'punct' && t.value === '=') {
            this.next();
            this.parseValue();
            break;
          }
          this.next();
        }
        const sep = this.peek();
        if (sep?.kind === 'punct' && sep.value === ',') this.next();
      }
      this.expectPunct(')');
    }
    const selection = this.parseSelectionSet();
    return { type, name, variables: {}, selection };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const out: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      const token = this.peek();
      if (token?.kind === 'punct' && token.value === '...') {
        this.next();
        const on = this.next();
        if (on.kind !== 'name' || on.value !== 'on') throw new Error('expected "on" after ... in GraphQL document');
        const type = this.expectName();
        out.push({ kind: 'fragment', type, selection: this.parseSelectionSet() });
        continue;
      }
      out.push({ kind: 'field', field: this.parseField() });
    }
    this.expectPunct('}');
    return out;
  }

  private parseField(): FieldNode {
    let alias: string | null = null;
    let name = this.expectName();
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
        const sep = this.peek();
        if (sep?.kind === 'punct' && sep.value === ',') this.next();
      }
      this.expectPunct(')');
    }
    let selection: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selection = this.parseSelectionSet();
    }
    return { alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ']')) {
        values.push(this.parseValue());
        const sep = this.peek();
        if (sep?.kind === 'punct' && sep.value === ',') this.next();
      }
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
        const sep = this.peek();
        if (sep?.kind === 'punct' && sep.value === ',') this.next();
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name] ?? null;
    case 'string': return node.value;
    case 'int': return node.value;
    case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema (the fields the suite's documents use)

const TYPE_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  User: ['login', 'id'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description'],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  IssueConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'title', 'body'],
  PullRequestConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFileConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
  BranchRef: ['name'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  AddCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const INTROSPECTION: Record<string, { fields: string[]; enumValues: string[] }> = {
  Issue: { fields: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'author'], enumValues: [] },
  PullRequest: { fields: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'url', 'createdAt', 'author'], enumValues: [] },
  Repository: { fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url'], enumValues: [] },
  SearchType: { fields: [], enumValues: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE'] },
  User: { fields: ['id', 'login', 'name'], enumValues: [] },
};

// ---------------------------------------------------------------- execution

interface Ctx {
  store: Store;
  errors: { message: string }[];
}

function decodeGlobalId(id: unknown): { kind: string; parts: string[] } | null {
  if (typeof id !== 'string') return null;
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (kind === undefined || kind === '') return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): string {
  if (pull.state === 'open') return 'OPEN';
  return pull.merged ? 'MERGED' : 'CLOSED';
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match !== null ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** The sub-selection of a named field inside a selection set, or null. */
function subSelection(sel: SelectionNode[] | null, fieldName: string): SelectionNode[] | null {
  if (sel === null) return null;
  for (const node of sel) {
    if (node.kind === 'field' && node.field.name === fieldName) return node.field.selection;
  }
  return null;
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

type AnyObj = Record<string, unknown>;

/** Execute a selection set against a resolved value of `typeName`. */
function executeSelection(ctx: Ctx, typeName: string, value: AnyObj | null, selection: SelectionNode[], variables: Record<string, unknown>): AnyObj | null {
  if (value === null) return null;
  const out: AnyObj = {};
  for (const node of selection) {
    if (node.kind === 'fragment') {
      // Inline fragments apply when the value's __typename matches (or is absent).
      const typename = typeof value.__typename === 'string' ? value.__typename : typeName;
      if (typename !== node.type) continue;
      const inner = executeSelection(ctx, node.type, value, node.selection, variables);
      if (inner !== null) Object.assign(out, inner);
      continue;
    }
    const field = node.field;
    const key = field.alias ?? field.name;
    const allowed = TYPE_FIELDS[typeName] ?? [];
    if (!allowed.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    const resolved = resolveField(ctx, typeName, value, field, variables);
    out[key] = resolved;
  }
  return out;
}

function resolveField(ctx: Ctx, typeName: string, value: AnyObj, field: FieldNode, variables: Record<string, unknown>): unknown {
  const args = argsOf(field, variables);
  const sel = field.selection;
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') {
        const viewer: AnyObj = { __typename: 'User', login: ctx.store.viewerLogin, id: globalId('User', ctx.store.viewerLogin) };
        return sel === null ? viewer : executeSelection(ctx, 'User', viewer, sel, variables);
      }
      if (field.name === 'repository') {
        const owner = args.owner as string;
        const name = args.name as string;
        const repo = typeof owner === 'string' && typeof name === 'string' ? ctx.store.getRepo(owner, name) : undefined;
        if (repo === undefined) return null;
        const repoObj = repoObject(ctx.store, repo);
        return sel === null ? repoObj : executeSelection(ctx, 'Repository', repoObj, sel, variables);
      }
      if (field.name === 'node') {
        const decoded = decodeGlobalId(args.id);
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = ctx.store.listRepos().find((r) => r.id === Number(decoded.parts[0]));
          if (repo === undefined) return null;
          const repoObj = repoObject(ctx.store, repo);
          return sel === null ? repoObj : executeSelection(ctx, 'Repository', repoObj, sel, variables);
        }
        if (decoded.kind === 'Issue') {
          const repo = ctx.store.listRepos().find((r) => r.id === Number(decoded.parts[0]));
          const issue = repo?.issues.find((i) => i.number === Number(decoded.parts[1]));
          if (issue === undefined || repo === undefined) return null;
          const issueObj = issueObject(repo, issue);
          return sel === null ? issueObj : executeSelection(ctx, 'Issue', issueObj, sel, variables);
        }
        return null;
      }
      if (field.name === '__type') {
        const typeNameArg = args.name as string;
        const info = INTROSPECTION[typeNameArg];
        if (info === undefined) return null;
        const typeObj: AnyObj = {
          __typename: '__Type',
          name: typeNameArg,
          kind: info.enumValues.length > 0 ? 'ENUM' : 'OBJECT',
          _fields: info.fields,
          _enumValues: info.enumValues,
        };
        return sel === null ? typeObj : executeSelection(ctx, '__Type', typeObj, sel, variables);
      }
      return null;
    }
    case '__Type': {
      if (field.name === 'fields') {
        const fields = (value._fields as string[]).map((name) => ({ __typename: '__Field', name }));
        return sel === null ? fields : fields.map((f) => executeSelection(ctx, '__Field', f, sel, variables));
      }
      if (field.name === 'enumValues') {
        const values = (value._enumValues as string[]).map((name) => ({ __typename: '__EnumValue', name }));
        return sel === null ? values : values.map((v) => executeSelection(ctx, '__EnumValue', v, sel, variables));
      }
      if (field.name === 'name') return value.name;
      if (field.name === 'kind') return value.kind;
      return null;
    }
    case 'Repository': {
      const repo = value._repo as Repo;
      if (field.name === 'issue') {
        const issue = repo.issues.find((i) => i.number === (args.number as number));
        if (issue === undefined) return null;
        const issueObj = issueObject(repo, issue);
        return sel === null ? issueObj : executeSelection(ctx, 'Issue', issueObj, sel, variables);
      }
      if (field.name === 'issues') {
        return issuesConnection(ctx, repo, args, sel, variables);
      }
      if (field.name === 'pullRequests') {
        const first = typeof args.first === 'number' ? args.first : undefined;
        let pulls = repo.pulls.slice().sort((a, b) => b.createdSeq - a.createdSeq);
        if (first !== undefined) pulls = pulls.slice(0, first);
        const nodeSel = subSelection(sel, 'nodes');
        const nodes = pulls.map((p) => {
          const obj = pullObject(ctx.store, repo, p);
          return nodeSel === null ? obj : executeSelection(ctx, 'PullRequest', obj, nodeSel, variables);
        });
        return { nodes };
      }
      if (field.name === 'pullRequest') {
        const pull = repo.pulls.find((p) => p.number === (args.number as number));
        if (pull === undefined) return null;
        const obj = pullObject(ctx.store, repo, pull);
        return sel === null ? obj : executeSelection(ctx, 'PullRequest', obj, sel, variables);
      }
      if (field.name === 'owner') {
        const owner: AnyObj = { __typename: 'User', login: repo.owner, id: globalId('User', repo.owner) };
        return sel === null ? owner : executeSelection(ctx, 'User', owner, sel, variables);
      }
      if (field.name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        const ref: AnyObj = { __typename: 'BranchRef', name: repo.defaultBranch };
        return sel === null ? ref : executeSelection(ctx, 'BranchRef', ref, sel, variables);
      }
      return value[field.name] ?? null;
    }
    case 'PullRequest': {
      if (field.name === 'files') {
        const pull = value._pull as PullRequest;
        const repo = value._repo as Repo;
        const first = typeof args.first === 'number' ? args.first : undefined;
        let files = pullFilesOf(ctx.store, repo, pull);
        if (first !== undefined) files = files.slice(0, first);
        const nodeSel = subSelection(sel, 'nodes');
        const nodes = files.map((f) => {
          const obj: AnyObj = { __typename: 'PullRequestChangedFile', path: f };
          return nodeSel === null ? obj : executeSelection(ctx, 'PullRequestChangedFile', obj, nodeSel, variables);
        });
        return { nodes };
      }
      return value[field.name] ?? null;
    }
    case 'Mutation': {
      return resolveMutation(ctx, field, variables);
    }
    default: {
      return value[field.name] ?? null;
    }
  }
}

function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>, sel: SelectionNode[] | null, variables: Record<string, unknown>): AnyObj {
  let list = repo.issues.slice();
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = args.orderBy as { field?: unknown; direction?: unknown } | undefined;
  if (orderBy !== undefined && orderBy.field === 'CREATED_AT') {
    if (orderBy.direction === 'DESC') list.sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
    else list.sort((a, b) => a.createdSeq - b.createdSeq || a.number - b.number);
  } else {
    list.sort((a, b) => a.number - b.number);
  }
  const afterNum = decodeCursor(args.after);
  if (afterNum !== null) list = list.filter((issue) => issue.number > afterNum);
  const first = typeof args.first === 'number' ? args.first : undefined;
  const hasMore = first !== undefined && list.length > first;
  const page = first !== undefined ? list.slice(0, first) : list;
  const nodeSel = subSelection(sel, 'nodes');
  const nodes = page.map((issue) => {
    const obj = issueObject(repo, issue);
    return nodeSel === null ? obj : executeSelection(ctx, 'Issue', obj, nodeSel, variables);
  });
  let pageInfo: AnyObj = { __typename: 'PageInfo', hasNextPage: hasMore, endCursor: page.length > 0 ? encodeCursor(page[page.length - 1].number) : null };
  const pageInfoSel = subSelection(sel, 'pageInfo');
  if (pageInfoSel !== null) {
    pageInfo = executeSelection(ctx, 'PageInfo', pageInfo, pageInfoSel, variables) ?? pageInfo;
  }
  return { nodes, pageInfo };
}

function pullFilesOf(_store: Store, repo: Repo, pull: PullRequest): string[] {
  const baseFlat = repo.flatTrees.get(`refs/heads/${pull.base}`) ?? new Map();
  const headFlat = repo.flatTrees.get(`refs/heads/${pull.head}`) ?? new Map();
  return Store.diffFlat(baseFlat, headFlat).map((c) => c.path);
}

function resolveMutation(ctx: Ctx, field: FieldNode, variables: Record<string, unknown>): unknown {
  const args = argsOf(field, variables);
  const input = (args.input ?? {}) as Record<string, unknown>;
  const sel = field.selection;
  if (field.name === 'createIssue') {
    const decoded = decodeGlobalId(input.repositoryId);
    const repo = decoded?.kind === 'Repository' ? ctx.store.listRepos().find((r) => r.id === Number(decoded.parts[0])) : undefined;
    if (repo === undefined) {
      ctx.errors.push({ message: 'repository not found' });
      return null;
    }
    const issue: Issue = {
      number: repo.nextNumber++,
      title: typeof input.title === 'string' ? input.title : '',
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      seq: repo.issues.length,
      comments: [],
      createdSeq: repo.issues.length,
    };
    repo.issues.push(issue);
    const result: AnyObj = { issue: issueObject(repo, issue) };
    if (sel === null) return result;
    return executeSelectionWithPayloads(ctx, 'CreateIssuePayload', result, sel, variables);
  }
  if (field.name === 'closeIssue') {
    const decoded = decodeGlobalId(input.issueId);
    const repo = decoded?.kind === 'Issue' ? ctx.store.listRepos().find((r) => r.id === Number(decoded.parts[0])) : undefined;
    const issue = repo?.issues.find((i) => i.number === Number(decoded?.parts[1]));
    if (repo === undefined || issue === undefined) {
      ctx.errors.push({ message: 'issue not found' });
      return null;
    }
    issue.state = 'closed';
    const result: AnyObj = { issue: issueObject(repo, issue) };
    if (sel === null) return result;
    return executeSelectionWithPayloads(ctx, 'CloseIssuePayload', result, sel, variables);
  }
  if (field.name === 'createPullRequest') {
    const decoded = decodeGlobalId(input.repositoryId);
    const repo = decoded?.kind === 'Repository' ? ctx.store.listRepos().find((r) => r.id === Number(decoded.parts[0])) : undefined;
    if (repo === undefined) {
      ctx.errors.push({ message: 'repository not found' });
      return null;
    }
    const head = typeof input.headRefName === 'string' ? input.headRefName : '';
    const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) {
      ctx.errors.push({ message: 'head or base branch does not exist' });
      return null;
    }
    let pull = repo.pulls.find((p) => p.head === head && p.base === base && p.state === 'open');
    if (pull === undefined) {
      pull = {
        number: repo.nextNumber++,
        title: typeof input.title === 'string' ? input.title : '',
        body: '',
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
    }
    const result: AnyObj = { pullRequest: pullObject(ctx.store, repo, pull) };
    if (sel === null) return result;
    return executeSelectionWithPayloads(ctx, 'CreatePullRequestPayload', result, sel, variables);
  }
  if (field.name === 'mergePullRequest') {
    const decoded = decodeGlobalId(input.pullRequestId);
    const repo = decoded?.kind === 'PullRequest' ? ctx.store.listRepos().find((r) => r.id === Number(decoded.parts[0])) : undefined;
    const pull = repo?.pulls.find((p) => p.number === Number(decoded?.parts[1]));
    if (repo === undefined || pull === undefined) {
      ctx.errors.push({ message: 'pull request not found' });
      return null;
    }
    if (pull.state === 'closed') {
      ctx.errors.push({ message: 'pull request is already closed' });
      return null;
    }
    // Reuse the REST merge logic via the store: squash the head tree onto the base.
    if (pullConflicts(ctx.store, repo, pull)) {
      ctx.errors.push({ message: 'Merge conflict' });
      return null;
    }
    const headFlat = repo.flatTrees.get(`refs/heads/${pull.head}`) ?? new Map<string, { oid: string; mode: string }>();
    const baseRef = `refs/heads/${pull.base}`;
    const changes = new Map<string, { oid: string; mode: string } | null>();
    const currentFlat = repo.flatTrees.get(baseRef) ?? new Map<string, { oid: string; mode: string }>();
    for (const [path, entry] of headFlat) changes.set(path, entry);
    for (const [path] of currentFlat) if (!headFlat.has(path)) changes.set(path, null);
    const mergeSha = ctx.store.commitOnRef(repo, baseRef, changes, `Merge pull request #${pull.number} from ${pull.head}`);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = '2025-01-01T00:00:00Z';
    pull.mergeSha = mergeSha;
    const result: AnyObj = { pullRequest: pullObject(ctx.store, repo, pull) };
    if (sel === null) return result;
    return executeSelectionWithPayloads(ctx, 'MergePullRequestPayload', result, sel, variables);
  }
  if (field.name === 'addComment') {
    const decoded = decodeGlobalId(input.subjectId);
    const repo = decoded?.kind === 'Issue' ? ctx.store.listRepos().find((r) => r.id === Number(decoded.parts[0])) : undefined;
    const issue = repo?.issues.find((i) => i.number === Number(decoded?.parts[1]));
    if (repo === undefined || issue === undefined) {
      ctx.errors.push({ message: 'issue not found' });
      return null;
    }
    const body = typeof input.body === 'string' ? input.body : '';
    const comment = { id: repo.nextCommentId++, body, seq: issue.comments.length };
    issue.comments.push(comment);
    const node: AnyObj = {
      __typename: 'IssueComment',
      id: globalId('IssueComment', repo.id, issue.number, comment.id),
      body: comment.body,
    };
    const result: AnyObj = { commentEdge: { node } };
    if (sel === null) return result;
    return executeSelectionWithPayloads(ctx, 'AddCommentPayload', result, sel, variables);
  }
  return null;
}

// Payload types resolve their single object field by name.
const PAYLOAD_FIELDS: Record<string, string> = {
  CreateIssuePayload: 'Issue',
  CloseIssuePayload: 'Issue',
  CreatePullRequestPayload: 'PullRequest',
  MergePullRequestPayload: 'PullRequest',
  AddCommentPayload: 'AddCommentEdge',
};

function repoObject(store: Store, repo: Repo): AnyObj {
  return {
    __typename: 'Repository',
    _repo: repo,
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: repo.owner,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
  };
}

function issueObject(repo: Repo, issue: Issue): AnyObj {
  return {
    __typename: 'Issue',
    _repo: repo,
    _issue: issue,
    id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    state: issueState(issue),
    body: issue.body,
  };
}

function pullObject(store: Store, repo: Repo, pull: PullRequest): AnyObj {
  return {
    __typename: 'PullRequest',
    _repo: repo,
    _pull: pull,
    id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    state: pullState(pull),
    merged: pull.merged,
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable: pullConflicts(store, repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
    title: pull.title,
    body: pull.body,
  };
}

// ---------------------------------------------------------------- HTTP entry

let gqlRequestCounter = 0;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  gqlRequestCounter += 1;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `gql-${gqlRequestCounter}`,
  });
  res.end(text);
}

function executeOperation(store: Store, query: string, variables: Record<string, unknown>): { data: AnyObj | null; errors: { message: string }[] } {
  const ctx: Ctx = { store, errors: [] };
  let operation: Operation;
  try {
    operation = new Parser(tokenize(query)).parseOperation();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'failed to parse query' }] };
  }
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  // Payload objects resolve their fields through the named object type.
  const root: AnyObj = { __typename: rootType };
  const data = executeSelectionWithPayloads(ctx, rootType, root, operation.selection, variables);
  return { data, errors: ctx.errors };
}

function executeSelectionWithPayloads(ctx: Ctx, typeName: string, value: AnyObj, selection: SelectionNode[], variables: Record<string, unknown>): AnyObj | null {
  // Payload wrappers (createIssue etc.) hold one object field; resolve it by type.
  if (typeName in PAYLOAD_FIELDS) {
    const out: AnyObj = {};
    for (const node of selection) {
      if (node.kind !== 'field') continue;
      const field = node.field;
      const key = field.alias ?? field.name;
      const inner = value[field.name] as AnyObj | undefined;
      if (inner === undefined || inner === null) { out[key] = null; continue; }
      const innerType = PAYLOAD_FIELDS[typeName] as string;
      if (innerType === 'AddCommentEdge') {
        out[key] = field.selection === null ? inner : executeSelectionWithPayloads(ctx, 'AddCommentEdge', inner, field.selection, variables);
        continue;
      }
      out[key] = field.selection === null ? inner : executeSelection(ctx, innerType, inner, field.selection, variables);
    }
    return out;
  }
  if (typeName === 'AddCommentEdge') {
    const out: AnyObj = {};
    for (const node of selection) {
      if (node.kind !== 'field') continue;
      const field = node.field;
      const key = field.alias ?? field.name;
      if (field.name === 'node') {
        const nodeObj = value.node as AnyObj;
        out[key] = field.selection === null ? nodeObj : executeSelection(ctx, 'IssueComment', nodeObj, field.selection, variables);
      } else {
        out[key] = value[field.name] ?? null;
      }
    }
    return out;
  }
  return executeSelection(ctx, typeName, value, selection, variables);
}

export async function handleGraphql(store: Store, token: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = req.headers.authorization ?? '';
  if (auth !== `Bearer ${token}`) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const rawBody = await readBody(req);
  let body: unknown;
  try {
    body = rawBody.length === 0 ? {} : JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(body)) {
    // Batched operations: one result per document, in order.
    const results = body.map((entry) => {
      if (entry === null || typeof entry !== 'object') return { data: null, errors: [{ message: 'invalid operation' }] };
      const op = entry as { query?: unknown; variables?: unknown };
      if (typeof op.query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
      const vars = (op.variables ?? {}) as Record<string, unknown>;
      return executeOperation(store, op.query, vars);
    });
    sendJson(res, 200, results);
    return;
  }
  if (body === null || typeof body !== 'object') {
    sendJson(res, 400, { errors: [{ message: 'query is required' }] });
    return;
  }
  const raw = body as Record<string, unknown>;
  const query = typeof raw.query === 'string' ? raw.query : null;
  if (query === null) {
    sendJson(res, 400, { errors: [{ message: 'query is required' }] });
    return;
  }
  const variables = (raw.variables ?? {}) as Record<string, unknown>;
  const result = executeOperation(store, query, variables);
  sendJson(res, 200, { data: result.data, ...(result.errors.length > 0 ? { errors: result.errors } : {}) });
}
