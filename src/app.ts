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
      pending = Promise.resolve()
        .then(() => assertConfigComplete())
        .then(() => Relayer.create(cfg))
        .then((relayer) => ({ relayer, proxy: new RpcProxy(relayer, cfg.rpcUrl) }))
        .catch((err) => {
          // Sin esto un fallo transitorio del nodo deja la instancia rota para siempre.
          pending = null;
          throw err;
        });
    }
    return pending;
  };

  const app = express();
  app.use(express.json({ limit: '2mb' }));

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

  app.get('/info', async (_req: Request, res: Response) => {
    try {
      const { relayer } = await ready();
      res.json(await relayer.info());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/nonce/:address', async (req: Request, res: Response) => {
    try {
      const address = getAddress(req.params.address);
      const { relayer } = await ready();
      // `nonce` = lo que dice la cadena; `nextNonce` = lo que hay que firmar ahora, contando
      // las metatx que este relayer ya mando y siguen sin minarse (necesario para encadenar).
      const [nonce, nextNonce] = await Promise.all([relayer.getNonce(address), relayer.nextNonce(address)]);
      res.json({
        address,
        nonce: nonce.toString(),
        nonceHex: '0x' + nonce.toString(16),
        nextNonce: nextNonce.toString(),
        nextNonceHex: '0x' + nextNonce.toString(16),
        pending: relayer.pendingCount(address),
      });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/relay', async (req: Request, res: Response) => {
    const rawTx = req.body?.rawTx ?? req.body?.signedTransaction;
    if (typeof rawTx !== 'string' || !isHexString(rawTx)) {
      res.status(400).json({ error: 'Expected { "rawTx": "0x..." }' });
      return;
    }
    try {
      const { relayer } = await ready();
      const result = await relayer.relay(rawTx);
      console.log(`[relay] ok ${result.transactionHash} from=${result.from} to=${result.to} executed=${result.executed}`);
      res.json(result);
    } catch (err) {
      if (err instanceof RelayError) {
        console.warn(`[relay] rejected (${err.code}): ${err.message}`);
        res.status(400).json({ error: err.message, code: err.code, details: err.details ?? null });
        return;
      }
      console.error('[relay] unexpected error', err);
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
      console.error('[rpc] unexpected error', err);
      res.json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: (err as Error).message } });
    }
  });

  return { app, ready };
}
