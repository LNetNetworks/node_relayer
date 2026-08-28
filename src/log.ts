/**
 * Log estructurado: una linea JSON por evento, a stdout/stderr.
 *
 * El formato de una linea por evento no es estetico, es funcional: Vercel captura stdout y
 * stderr de la funcion y los indexa como texto, asi que un objeto JSON plano se puede filtrar
 * por `event`, `reqId` o `code` desde el dashboard o con `vercel logs`. Un log multilinea
 * (un stack, un objeto pretty-printed) se parte en entradas separadas y deja de ser buscable.
 *
 * `warn` y `error` salen por stderr para que Vercel los clasifique como tales y se puedan
 * filtrar por nivel; `debug` e `info` por stdout.
 *
 * El `reqId` viaja por AsyncLocalStorage: asi los eventos que emite el relayer (varias fases
 * asincronicas, algunas despues de haber respondido) se correlacionan con la request que los
 * origino sin tener que pasar el id por parametro por todo el arbol de llamadas.
 */
import { AsyncLocalStorage } from 'async_hooks';
import { randomBytes } from 'crypto';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const SEVERITY: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function configuredLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.trim().toLowerCase();
  return raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
}

/**
 * Incluir la raw tx completa en el log. Apagado por defecto: un deploy son varios KB de
 * initcode y Vercel recorta las lineas largas, con lo que se pierde el resto del evento.
 * La raw tx igual queda identificada por `rawTxHash` y `rawTxBytes`.
 */
function logRawTx(): boolean {
  return (process.env.LOG_RAW_TX ?? 'false') === 'true';
}

/**
 * Id de esta instancia del proceso. Va en cada linea a proposito: es la unica forma de ver,
 * leyendo el log, si dos instancias estuvieron sirviendo a la vez. Importa porque el tracker de
 * nonces vive en memoria y asume una sola (ver "Supuesto: una sola instancia" en el README):
 * dos `instanceId` distintos relayando para el mismo `from` es el escenario que rompe la cadena.
 */
const INSTANCE_ID = randomBytes(4).toString('hex');

interface LogContext {
  reqId: string;
  [key: string]: unknown;
}

const contextStore = new AsyncLocalStorage<LogContext>();

/** Id corto: alcanza para correlacionar dentro de una ventana de logs, y no infla cada linea. */
export function newRequestId(): string {
  return randomBytes(6).toString('hex');
}

/** Corre `fn` con un contexto de log que heredan todos los eventos asincronicos de adentro. */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  return contextStore.run(ctx, fn);
}

export function currentLogContext(): LogContext | undefined {
  return contextStore.getStore();
}

export function shouldLogRawTx(): boolean {
  return logRawTx();
}

/** Aplana un error a campos loggeables. El stack va en una sola linea y acotado. */
export function errorFields(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { error: String(err) };
  const out: Record<string, unknown> = { error: err.message, errorType: err.constructor.name };
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') out.code = code;
  const details = (err as { details?: unknown }).details;
  if (details !== undefined && details !== null) out.details = details;
  if (err.stack) out.stack = err.stack.split('\n').slice(0, 6).map((l) => l.trim()).join(' | ');
  return out;
}

/** Serializa descartando `undefined` y convirtiendo bigint, que JSON.stringify no soporta. */
function emit(level: LogLevel, event: string, fields: Record<string, unknown>): void {
  if (SEVERITY[level] < SEVERITY[configuredLevel()]) return;

  const ctx = contextStore.getStore();
  const line: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    event,
    instanceId: INSTANCE_ID,
    ...(ctx ?? {}),
    ...fields,
  };

  let text: string;
  try {
    text = JSON.stringify(line, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  } catch {
    // Un campo circular no puede tumbar el pedido que se estaba loggeando.
    text = JSON.stringify({ ts: line.ts, level, event, logError: 'no se pudo serializar el evento' });
  }
  if (level === 'warn' || level === 'error') console.error(text);
  else console.log(text);
}

export const log = {
  debug: (event: string, fields: Record<string, unknown> = {}) => emit('debug', event, fields),
  info: (event: string, fields: Record<string, unknown> = {}) => emit('info', event, fields),
  warn: (event: string, fields: Record<string, unknown> = {}) => emit('warn', event, fields),
  error: (event: string, fields: Record<string, unknown> = {}) => emit('error', event, fields),
};
