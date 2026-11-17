# github-core-clone-01 — a standalone GitHub-compatible forge

One Node process (stdlib only, no dependencies) serving four surfaces over a
single in-memory object store:

- **git smart HTTP** — upload-pack protocol v2 (with a v0 advertisement for
  clients that ask for it) and receive-pack v0: `ls-refs` with prefix
  filtering, symrefs and peeled tags, full and incremental fetches, shallow
  clones (`deepen`, `deepen-since` boundaries, `unshallow`), fast-forward
  enforcement with per-ref `ok`/`ng` report-status, and sideband framing.
  Packs are sent as full objects (no deltas); every object id recomputes.
- **REST v3** (`/api/v3`) — repositories, Git Data refs, contents (create /
  read / update / delete with sha checks), labels, issues (filters, comments),
  pull requests (create, list, files, squash merge with a real three-way
  conflict check against the merge base), plus the protocol rules the suite
  checks: JSON everywhere, `X-GitHub-Request-Id` on every reply, 401 without
  the bearer token, 404 (never 403) for another owner's repo name.
- **GraphQL** (`/api/graphql`) — a hand-rolled parser/executor for the
  `viewer`, `repository`, `issues` (connections with cursors, `orderBy`,
  `states`), `node`, and the `createIssue` / `closeIssue` /
  `createPullRequest` / `mergePullRequest` / `addComment` mutations, with
  introspection (`__type`, `__schema`) and opaque, stable global ids.
  Batched operations are answered in order; GraphQL-level errors are HTTP 200.
- **MCP** (`/mcp`) — JSON-RPC 2.0 over Streamable HTTP, speaking both the
  modern 2026-07-28 era (`server/discover`, revision in `_meta`) and the
  legacy handshake era (`initialize` + `notifications/initialized`). Seven
  tools — `create_repo`, `get_repo`, `create_issue`, `get_issue`,
  `list_issues`, `create_pull_request`, `merge_pull_request` — acting on the
  same store as REST, so objects created over MCP read back identically over
  REST with stable ids.

## Running it

```sh
node --experimental-strip-types main.ts   # needs MAKEFUN_ENV_URL + MAKEFUN_SHOP_TOKEN
```

`main.ts` is the entry/env lifecycle: bind an ephemeral port, register it
with the env, long-poll `/done`, exit 0. For local testing, start the server
directly and point the kit's runner at it:

```sh
MAKEFUN_SHOP_TOKEN=test-token-123 node --experimental-strip-types -e "
  import('./app.ts').then(({ createApp }) => createApp().listen(18099));"
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:18099 \
  --token test-token-123 [--perf]
```

Requires Node 22 (type-stripping). No build step, no dependencies.

## Layout

| file | what it is |
| --- | --- |
| `main.ts` | entry/env lifecycle (bind, register, poll `/done`) |
| `app.ts` | HTTP server and routing between the four surfaces |
| `store.ts` | the object store: git objects, refs, flat trees, issues, PRs |
| `git.ts` | smart HTTP: pkt-lines, advertisements, ls-refs, fetch planning, receive-pack |
| `rest.ts` | REST v3 router, JSON serializers, squash merge, conflict check |
| `graphql.ts` | GraphQL tokenizer, parser, executor, introspection |
| `mcp.ts` | MCP JSON-RPC layer and the seven tools |
| `scenario.ts` | the scenario's deterministic viewer identity (derived, not hardcoded) |

## Design notes

- **One store, four views.** A branch pushed over git is readable over REST
  and GraphQL (its flat tree is rebuilt from the pushed objects), and a pull
  request merged over MCP closes the same record REST reads.
- **Fetch planning** (`planFetch` in `git.ts`) computes the exact object set
  for a fetch: BFS distance from the wants (capped by `deepen`), minus what
  the client's haves already hold — where a shallow boundary's parents are
  not held even though the boundary itself is. That is what makes
  incremental fetches send only new objects and `deepen 2` move the boundary
  by exactly one generation.
- **Fast paths.** The REST router caches the route a `METHOD path` matched
  (the timed workloads repeat one path thousands of times), and the server
  parses request URLs by hand instead of constructing `URL` objects.
- **Determinism.** Repository ids, issue/PR numbers and commit timestamps
  come from counters, never the clock or randomness, so repeated runs of the
  suite see identical state.

## Local results

Against the kit's local runner (`sdk/run.ts`, byte-identical to the sealed
suite): **120/120 conformance checks pass** (git 30, repos 15, issues 15,
pulls 20, GraphQL 20, MCP 15, protocol 5) — feature 600/600, agent 200/200.
Timed workloads (medians of 3 rounds, local VM): push ~1.1–1.8 s,
clone ~0.3–0.4 s, read ~1.5–1.6 s, write ~0.21 s — perf 111–120/200 against
the house baseline's reference times. Timings vary run to run on a shared
machine; conformance does not.

## License

MIT — see `LICENSE`.
