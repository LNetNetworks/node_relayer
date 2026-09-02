/**
 * Monitor en vivo: `GET /dashboard` sirve la pagina y `GET /dashboard/stream` empuja por
 * Server-Sent Events el mismo log estructurado que sale por stdout.
 *
 * Por que SSE y no WebSocket: el flujo es de una sola direccion (el browser no manda nada), va
 * sobre HTTP comun --el puerto ya esta abierto y el WS del proceso ya esta ocupado proxeando
 * `eth_subscribe` contra el nodo-- y el navegador reconecta solo. Con `Last-Event-ID` mas el
 * buffer de `src/events.ts`, una reconexion no deja huecos.
 *
 * Lo que se ve es lo que esta instancia vio: el bus vive en memoria, igual que el tracker de
 * nonces (ver "Supuesto: una sola instancia" en el README). Detras de varias instancias, cada
 * pagina muestra la que le toco.
 *
 * El dashboard no autentica, como el resto del servicio: publica quien mando cada metatx, con
 * que nonce y contra que contrato. Se apaga con DASHBOARD=false.
 */
import { Request, Response, Router } from 'express';
import { StreamEvent, replay, subscribe, subscriberCount } from './events';
import { instanceId, jsonReplacer, log } from './log';
import { DASHBOARD_HTML } from './dashboard-page';

/** Techo de pestanas abiertas a la vez. Cada una es una conexion HTTP colgada del proceso. */
const MAX_CLIENTS = 8;

/** Comentario SSE periodico: mantiene viva la conexion a traves de proxies que cortan por idle. */
const HEARTBEAT_MS = 15_000;

export function dashboardRouter(): Router {
  const router = Router();

  router.get('/dashboard', (_req: Request, res: Response) => {
    res.type('html').send(DASHBOARD_HTML);
  });

  router.get('/dashboard/stream', (req: Request, res: Response) => {
    if (subscriberCount() >= MAX_CLIENTS) {
      res.status(503).json({ error: `The dashboard already has ${MAX_CLIENTS} open streams` });
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Sin esto un proxy con buffering (nginx por delante) retiene el stream y no llega nada.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    // Los eventos son chicos y frecuentes: agruparlos agrega latencia visible en la pagina.
    req.socket.setNoDelay(true);
    res.write('retry: 2000\n\n');

    const send = (event: Record<string, unknown>, seq?: number): void => {
      if (seq !== undefined) res.write(`id: ${seq}\n`);
      res.write(`data: ${JSON.stringify(event, jsonReplacer)}\n\n`);
    };

    send({ event: 'dashboard.hello', instanceId: instanceId(), pid: process.pid });

    // `after` lo manda la pagina con el ultimo seq que ya mostro; `last-event-id`, el reintento
    // automatico del browser. Con cualquiera de los dos, la reconexion retoma sin huecos ni
    // repetidos --siempre que lo perdido siga en el buffer.
    const header = req.header('last-event-id');
    const after = Number(req.query.after ?? header ?? 0);
    for (const event of replay(Number.isFinite(after) ? after : 0)) send(event, event.seq);

    // Se suscribe despues del replay y sin `await` en el medio: nada puede publicarse entre
    // las dos cosas, asi que no hay ventana por donde se pierda un evento.
    const unsubscribe = subscribe((event: StreamEvent) => send(event, event.seq));

    const beat = setInterval(() => res.write(': hb\n\n'), HEARTBEAT_MS);
    beat.unref?.();

    const close = (): void => {
      clearInterval(beat);
      unsubscribe();
    };
    req.on('close', close);
    res.on('close', close);

    log.debug('dashboard.stream_open', { after, clients: subscriberCount() });
  });

  return router;
}
