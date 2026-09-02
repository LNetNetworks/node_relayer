/**
 * Nucleo HTTP del relayer, compartido por el arranque local (`src/server.ts`) y por el
 * despliegue serverless (`api/index.ts`).
 *
 * El `Relayer` se crea perezosamente y memoizado: `Relayer.create()` hace llamadas al nodo
 * (chainId, resolucion del hub, permissioning), y hacerlas al importar el modulo convierte
 * cualquier problema de red en un fallo de cold start sin traza util.
 *
 * El servicio no autentica: `/relay` y el JSON-RPC quedan abiertos a quien alcance la URL.
 */
import express, { NextFunction, Request, Response } from 'express';
import { getAddress, isHexString } from 'ethers';
import { Config, assertConfigComplete, config as defaultConfig } from './config';
import { RelayError, Relayer } from './relayer';
import { RpcProxy } from './rpc-proxy';
import { dashboardRouter } from './dashboard';
import { errorFields, log, newRequestId, withLogContext } from './log';

export interface RelayApp {
  app: express.Express;
  /** Fuerza la inicializacion del relayer (el arranque local la usa para el banner). */
  ready: () => Promise<{ relayer: Relayer; proxy: RpcProxy }>;
}

export function createRelayApp(cfg: Config = defaultConfig): RelayApp {
  let pending: Promise<{ relayer: Relayer; proxy: RpcProxy }> | null = null;

  const ready = (): Promise<{ relayer: Relayer; proxy: RpcProxy }> => {
    if (pending === null) {
      // Dentro de la request: si falta una variable, sale un 500 con el nombre de la que falta
      // en vez de un FUNCTION_INVOCATION_FAILED sin causa.
      const initStartedAt = Date.now();
      pending = Promise.resolve()
        .then(() => assertConfigComplete())
        .then(() => Relayer.create(cfg))
        .then(async (relayer) => {
          // Una vez por instancia (cold start): deja registrado contra que hub y con que writer
          // node quedo atada esta instancia, que es lo primero que hay que saber al leer el log.
          const info = await relayer.info();
          log.info('relayer.ready', {
            ms: Date.now() - initStartedAt,
            rpcUrl: info.rpcUrl,
            chainId: info.chainId,
            nodeAddress: info.nodeAddress,
            relayHubAddress: info.relayHubAddress,
            relayHubSource: info.relayHubSource,
            accountRulesAddress: info.accountRulesAddress,
            nodePermitted: info.nodePermitted,
            enforceAccountRules: info.enforceAccountRules,
            currentGasLimit: info.currentGasLimit,
            autoNonce: info.autoNonce,
            autoNonceTicketMs: info.autoNonceTicketMs,
          });
          if (info.autoNonce) {
            // El handout serializa en memoria del proceso: con mas de una instancia por clave de
            // writer node la garantia no existe (dos pedidos concurrentes caen en instancias
            // distintas y se llevan el mismo nonce). Ver el README.
            log.warn('relayer.auto_nonce', {
              ticketMs: info.autoNonceTicketMs,
              note:
                'the relayer hands out nonces and serializes the requests of each user. The ' +
                'guarantee holds per process: it requires a single instance per writer node key.',
            });
          }
          return { relayer, proxy: new RpcProxy(relayer, cfg.rpcUrl) };
        })
        .catch((err) => {
          log.error('relayer.init_failed', { ms: Date.now() - initStartedAt, ...errorFields(err) });
          // Sin esto un fallo transitorio del nodo deja la instancia rota para siempre.
          pending = null;
          throw err;
        });
    }
    return pending;
  };

  const app = express();

  /**
   * Primero de todo: abre el contexto de log para que TODO lo que pase despues --incluido un
   * body que no parsea-- salga con el mismo `reqId`. `x-vercel-id` se loggea para poder cruzar
   * este log con la entrada que arma Vercel por su cuenta.
   */
  app.use((req: Request, res: Response, next: NextFunction) => {
    const reqId = newRequestId();
    const startedAt = Date.now();
    res.setHeader('x-request-id', reqId);

    withLogContext({ reqId }, () => {
      log.info('http.request', {
        method: req.method,
        path: req.originalUrl,
        ip: (req.header('x-forwarded-for') ?? '').split(',')[0].trim() || req.socket.remoteAddress || null,
        userAgent: req.header('user-agent') ?? null,
        contentLength: Number(req.header('content-length') ?? 0),
        vercelId: req.header('x-vercel-id') ?? null,
        country: req.header('x-vercel-ip-country') ?? null,
      });
      res.on('finish', () => {
        log.info('http.response', { status: res.statusCode, ms: Date.now() - startedAt });
      });
      next();
    });
  });

  app.use(express.json({ limit: '2mb' }));

  // express.json rechaza el body invalido con un error propio: sin esto seria un 400 mudo.
  app.use((err: Error, _req: Request, res: Response, next: NextFunction) => {
    if (err) {
      log.warn('http.bad_body', errorFields(err));
      res.status(400).json({ error: `Invalid JSON body: ${err.message}` });
      return;
    }
    next();
  });

  // Un dapp de browser no puede hablarle al relayer sin esto.
  if (cfg.corsOrigin !== '') {
    app.use((req: Request, res: Response, next: NextFunction) => {
      res.header('Access-Control-Allow-Origin', cfg.corsOrigin);
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
      next();
    });
  }

  // Monitor en vivo (`GET /dashboard`). No toca al relayer: lee el bus de eventos, que es un
  // derivado del log, asi que montarlo no cambia en nada el camino de una metatx.
  if (cfg.dashboardEnabled) app.use(dashboardRouter());

  app.get('/info', async (_req: Request, res: Response) => {
    try {
      const { relayer } = await ready();
      res.json(await relayer.info());
    } catch (err) {
      log.error('info.failed', errorFields(err));
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/nonce/:address', async (req: Request, res: Response) => {
    try {
      const address = getAddress(req.params.address);
      const { relayer } = await ready();
      // `nonce` = lo que dice la cadena; `nextNonce` = lo que hay que firmar ahora, contando
      // las metatx que este relayer ya mando y siguen sin minarse (necesario para encadenar).
      //
      // `nextNonce` pasa por el handout, asi que con AUTO_NONCE pedirlo RESERVA el numero para
      // quien lo pidio. `?peek=true` mira sin reservar: es para inspeccionar (curl, pruebas) sin
      // meterse en la cola de un cliente que esta mandando metatx.
      const peek = req.query.peek === 'true' || req.query.peek === '1';
      const [nonce, nextNonce] = await Promise.all([
        relayer.getNonce(address),
        peek ? relayer.nextNonce(address) : relayer.handOutNonce(address),
      ]);
      res.json({
        address,
        nonce: nonce.toString(),
        nonceHex: '0x' + nonce.toString(16),
        nextNonce: nextNonce.toString(),
        nextNonceHex: '0x' + nextNonce.toString(16),
        pending: relayer.pendingCount(address),
      });
    } catch (err) {
      log.warn('nonce.failed', { address: req.params.address, ...errorFields(err) });
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/relay', async (req: Request, res: Response) => {
    const rawTx = req.body?.rawTx ?? req.body?.signedTransaction;
    if (typeof rawTx !== 'string' || !isHexString(rawTx)) {
      log.warn('relay.bad_request', { reason: 'missing or non-hex rawTx', bodyKeys: Object.keys(req.body ?? {}) });
      res.status(400).json({ error: 'Expected { "rawTx": "0x..." }' });
      return;
    }
    try {
      const { relayer } = await ready();
      const result = await relayer.relay(rawTx);
      res.json(result);
    } catch (err) {
      if (err instanceof RelayError) {
        // El detalle ya salio en relay.rejected; aca solo queda la forma de la respuesta.
        res.status(400).json({ error: err.message, code: err.code, details: err.details ?? null });
        return;
      }
      log.error('relay.unexpected_error', errorFields(err));
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/', async (req: Request, res: Response) => {
    try {
      const { proxy } = await ready();
      const result = await proxy.handle(req.body);
      // Un batch de puras notificaciones no lleva cuerpo de respuesta.
      if (result === null) {
        res.sendStatus(204);
        return;
      }
      res.json(result);
    } catch (err) {
      log.error('rpc.unexpected_error', errorFields(err));
      res.json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: (err as Error).message } });
    }
  });

  return { app, ready };
}
