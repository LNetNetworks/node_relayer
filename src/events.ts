/**
 * Bus de eventos en memoria: el mismo log estructurado que sale por stdout, tambien disponible
 * para que alguien lo mire en vivo (`src/dashboard.ts`).
 *
 * Es un derivado del log, no una instrumentacion aparte, a proposito: cada linea que emite
 * `src/log.ts` pasa por aca sin que el relayer tenga que saber que existe un dashboard. Asi no
 * hay dos verdades sobre lo que paso, y agregar un evento al log lo agrega al dashboard.
 *
 * Vive en memoria del proceso, igual que el tracker de nonces, y con el mismo supuesto: una sola
 * instancia (ver "Supuesto: una sola instancia" en el README). En serverless cada instancia solo
 * muestra lo suyo, y lo que se ve depende de a cual haya caido la request.
 */

/** Una linea de log ya armada, mas el numero de secuencia que permite reanudar el stream. */
export interface StreamEvent {
  seq: number;
  ts: string;
  level: string;
  event: string;
  [key: string]: unknown;
}

type Subscriber = (event: StreamEvent) => void;

/**
 * Cuantos eventos se guardan para el que se conecta tarde. 0 apaga el bus entero: `publish`
 * queda en un `return` y no se paga nada por linea de log.
 */
function capacity(): number {
  if ((process.env.DASHBOARD ?? 'true') === 'false') return 0;
  const raw = Number(process.env.DASHBOARD_BUFFER);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 500;
}

const MAX_EVENTS = capacity();

const buffer: StreamEvent[] = [];
const subscribers = new Set<Subscriber>();
let sequence = 0;

/** Publica una linea de log en el bus. La llama `src/log.ts`; nadie mas deberia. */
export function publish(line: Record<string, unknown>): void {
  if (MAX_EVENTS === 0) return;

  const event: StreamEvent = {
    ...(line as StreamEvent),
    seq: ++sequence,
    ts: typeof line.ts === 'string' ? line.ts : new Date().toISOString(),
    level: typeof line.level === 'string' ? line.level : 'info',
    event: typeof line.event === 'string' ? line.event : 'unknown',
  };

  buffer.push(event);
  if (buffer.length > MAX_EVENTS) buffer.splice(0, buffer.length - MAX_EVENTS);

  // Un subscriber que rompe no puede tumbar la request que se estaba loggeando.
  for (const notify of subscribers) {
    try {
      notify(event);
    } catch {
      /* ignorado: el dashboard es observacion, nunca causa de un fallo */
    }
  }
}

/** Eventos retenidos, opcionalmente solo los posteriores a `afterSeq` (reconexion del stream). */
export function replay(afterSeq = 0): StreamEvent[] {
  return afterSeq > 0 ? buffer.filter((e) => e.seq > afterSeq) : [...buffer];
}

/** Se suscribe a los eventos nuevos. Devuelve la funcion que corta la suscripcion. */
export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function eventsEnabled(): boolean {
  return MAX_EVENTS > 0;
}

export function subscriberCount(): number {
  return subscribers.size;
}
