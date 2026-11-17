// The forge's process lifecycle: bind, register, serve, wait for /done.
//
// This file owns the handshake with the suite (the env) and nothing else.
// The forge itself — git smart HTTP, REST v3, GraphQL and MCP — lives in
// app.ts and is built by createApp(); this module only starts it, tells the
// env where it listens, and stays up until the env says the trial is over:
//
//   1. bind an ephemeral port (never 8080: the env listens there),
//   2. POST {"port": N} to $MAKEFUN_ENV_URL/register,
//   3. serve requests while polling GET $MAKEFUN_ENV_URL/done,
//   4. on {"done": true} shut the server down and exit 0.
//
// Configuration comes from the environment: MAKEFUN_ENV_URL names the env
// (required); FORGE_HOST / FORGE_PORT optionally pin the listen address
// (defaults: 0.0.0.0 and an ephemeral port). Nothing here reads the clock
// for data, and no timing leaks into the forge's state.

import { createApp } from './app.ts';
import type { Server } from 'node:http';

// ---------------------------------------------------------------- logging

type LogLevel = 'info' | 'warn' | 'error';

/** One structured line on stderr: a timestamp, a level, an event, fields. */
function logLine(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields });
  process.stderr.write(`${line}\n`);
}

// ---------------------------------------------------------------- configuration

interface ForgeConfig {
  /** The env's origin, e.g. http://127.0.0.1:8080. */
  readonly envUrl: string;
  /** The interface the forge binds. */
  readonly host: string;
  /** The port to bind; 0 asks the kernel for an ephemeral one. */
  readonly port: number;
}

/** The port the env itself listens on: the forge must never claim it. */
const ENV_PORT = 8080;
/** The longest the register retries run before giving up. */
const REGISTER_BUDGET_MS = 15_000;
/** One register attempt's own timeout. */
const REGISTER_ATTEMPT_TIMEOUT_MS = 5_000;
/** One /done request's own timeout (the env answers at once, never held). */
const DONE_REQUEST_TIMEOUT_MS = 10_000;
/** The first wait between /done polls, doubling to the cap below. */
const DONE_POLL_FIRST_MS = 250;
/** The longest wait between /done polls. */
const DONE_POLL_MAX_MS = 2_000;
/** The longest a graceful server close may take before the process leaves anyway. */
const SHUTDOWN_GRACE_MS = 2_000;

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`FORGE_PORT must be an integer 0..65535, not ${JSON.stringify(raw)}`);
  }
  return port;
}

/** Read the process's configuration, or throw a message naming what is wrong. */
function readConfig(): ForgeConfig {
  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').trim();
  if (envUrl === '') {
    throw new Error('MAKEFUN_ENV_URL is not set: the forge cannot find its env to register with');
  }
  const host = (process.env.FORGE_HOST ?? '').trim() || '0.0.0.0';
  const port = parsePort(process.env.FORGE_PORT, 0);
  if (port === ENV_PORT) {
    throw new Error(`FORGE_PORT must not be ${ENV_PORT}: the env listens there`);
  }
  return { envUrl, host, port };
}

// ---------------------------------------------------------------- small helpers

/** Sleep unless `signal` fires first; false when the sleep was cut short. */
function sleepUnlessStopped(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, Math.max(0, ms));
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** `base` + `path` with exactly one slash between them. */
function envPath(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

/** The wait before the next /done poll: 250 ms, doubling, capped at 2 s. */
function donePollDelayMs(attempt: number): number {
  const step = Number.isFinite(attempt) ? Math.max(0, Math.trunc(attempt)) : 0;
  return Math.min(DONE_POLL_MAX_MS, Math.round(DONE_POLL_FIRST_MS * 2 ** step));
}

/** Bind `server` and resolve with the port the kernel actually gave it. */
function listenOn(server: Server, host: string, port: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the forge bound a socket with no TCP address'));
        return;
      }
      resolve(address.port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** Close the server, dropping idle keep-alive connections so close() returns. */
function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    server.close(() => settle());
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    setTimeout(settle, SHUTDOWN_GRACE_MS).unref();
  });
}

// ---------------------------------------------------------------- the register step

/**
 * Tell the env which port the forge listens on. The first register wins,
 * so a 409 means another process already claimed the trial: fatal. Any
 * other failure (the env not yet up, a dropped connection) is retried with
 * backoff until the budget runs out.
 */
async function registerWithEnv(envUrl: string, port: number, signal: AbortSignal): Promise<void> {
  const target = envPath(envUrl, '/register');
  const alreadyRegistered = new Error('the env answered 409: another entry already registered for this trial');
  const budgetEndsAt = Date.now() + REGISTER_BUDGET_MS;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(REGISTER_ATTEMPT_TIMEOUT_MS)]),
      });
      if (response.status === 200) {
        logLine('info', 'forge.registered', { port, attempt });
        return;
      }
      if (response.status === 409) throw alreadyRegistered;
      logLine('warn', 'forge.register-retry', { status: response.status, attempt });
    } catch (err) {
      if (err === alreadyRegistered) throw err;
      if (signal.aborted) throw new Error('register stopped: the process is shutting down');
      logLine('warn', 'forge.register-retry', {
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (Date.now() >= budgetEndsAt) {
      throw new Error(`could not register with the env at ${target} after ${attempt} attempts`);
    }
    const rested = await sleepUnlessStopped(100 * attempt, signal);
    if (!rested) throw new Error('register stopped: the process is shutting down');
  }
}

// ---------------------------------------------------------------- the /done poll

/**
 * Poll GET /done until the env says the suite is over. The env answers at
 * once (never holding a request), so this is a plain poll with exponential
 * backoff, not a long hold. A dropped request or a malformed answer is
 * treated as "not yet": only done === true ends the trial.
 */
async function waitForSuiteDone(envUrl: string, signal: AbortSignal): Promise<'done' | 'stopped'> {
  const target = envPath(envUrl, '/done');
  let attempt = 0;
  for (;;) {
    if (signal.aborted) return 'stopped';
    try {
      const response = await fetch(target, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(DONE_REQUEST_TIMEOUT_MS)]),
      });
      const body: unknown = await response.json();
      if (typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true) {
        return 'done';
      }
    } catch (err) {
      if (signal.aborted) return 'stopped';
      logLine('warn', 'forge.done-poll-retry', {
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const delay = donePollDelayMs(attempt);
    attempt += 1;
    const rested = await sleepUnlessStopped(delay, signal);
    if (!rested) return 'stopped';
  }
}

// ---------------------------------------------------------------- the four steps

/**
 * The four steps, in order: read the configuration, bind the forge, register
 * it with the env, then serve until the env says done (or a signal asks the
 * process to stop). Returns the process's exit code: 0 when the suite
 * finished or the process was asked to stop, 1 when the process itself
 * failed to start or register.
 */
async function start(): Promise<number> {
  let config: ForgeConfig;
  try {
    config = readConfig();
  } catch (err) {
    logLine('error', 'forge.bad-config', { error: err instanceof Error ? err.message : String(err) });
    return 1;
  }
  logLine('info', 'forge.starting', {
    env: config.envUrl,
    host: config.host,
    port: config.port === 0 ? 'ephemeral' : config.port,
  });

  const stop = new AbortController();
  const onSignal = (name: string): void => {
    logLine('info', 'forge.signal', { signal: name });
    stop.abort();
  };
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));

  const server = createApp();
  let port: number;
  try {
    port = await listenOn(server, config.host, config.port);
  } catch (err) {
    logLine('error', 'forge.listen-failed', { error: err instanceof Error ? err.message : String(err) });
    return 1;
  }
  logLine('info', 'forge.listening', { host: config.host, port });

  try {
    await registerWithEnv(config.envUrl, port, stop.signal);
  } catch (err) {
    logLine('error', 'forge.register-failed', { error: err instanceof Error ? err.message : String(err) });
    await closeServer(server);
    return 1;
  }

  const outcome = await waitForSuiteDone(config.envUrl, stop.signal);
  if (outcome === 'done') {
    logLine('info', 'forge.done', { port });
  } else {
    logLine('info', 'forge.stopped', { port });
  }
  await closeServer(server);
  return 0;
}

try {
  process.exitCode = await start();
} catch (err) {
  logLine('error', 'forge.unexpected', { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
}
