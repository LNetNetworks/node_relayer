/**
 * Servidor del relayer.
 *
 * Dos interfaces sobre el mismo nucleo:
 *
 *  REST (simple, para probar a mano):
 *    GET  /info               -> node address, relayHub, chainId, gas disponible
 *    GET  /nonce/:address     -> nonce del usuario dentro del RelayHub (+ nextNonce con lo en vuelo)
 *    POST /relay {rawTx}      -> relaya la metatx y devuelve el resultado ya decodificado
 *
 *  JSON-RPC (drop-in: un dapp que ya anda contra el relay-signer apunta su provider aca):
 *    POST /  lecturas   -> passthrough crudo al nodo
 *            escrituras -> se relayan como metatx
 *    ws://   lo mismo, mas eth_subscribe / eth_unsubscribe contra el WS del nodo
 *    Ver src/rpc-proxy.ts y src/ws-proxy.ts para el ruteo metodo por metodo.
 */
import express, { NextFunction, Request, Response } from 'express';
import { createServer } from 'http';
import { getAddress, isHexString } from 'ethers';
import { config } from './config';
import { RelayError, Relayer } from './relayer';
import { RpcProxy } from './rpc-proxy';
import { attachWsProxy } from './ws-proxy';

async function main() {
  const relayer = await Relayer.create(config);
  const info = await relayer.info();

  console.log('--- simple_relay ---');
  console.log(`RPC            : ${info.rpcUrl}`);
  console.log(`chainId        : ${info.chainId}`);
  console.log(`writer node    : ${info.nodeAddress}`);
  console.log(`RelayHub       : ${info.relayHubAddress} (via ${info.relayHubSource})`);
  console.log(`gas del bloque : ${info.currentGasLimit ?? 'n/d'}`);
  console.log(
    `AccountRules   : ${info.accountRulesAddress ?? 'no disponible en esta cadena'}` +
      (info.accountRulesAddress === null ? '' : ` (via ${info.accountRulesSource})`),
  );
  console.log(
    `  writer node  : ${info.nodePermitted === null ? 'sin chequear' : info.nodePermitted ? 'permisionado' : 'NO PERMISIONADO'}`,
  );
  console.log(`  sender       : ${info.enforceAccountRules ? 'se exige permissioning' : 'no se valida'}`);

  const app = express();
  app.use(express.json({ limit: '2mb' }));

  // Un dapp de browser no puede hablarle al relayer sin esto.
  if (config.corsOrigin !== '') {
    app.use((req: Request, res: Response, next: NextFunction) => {
      res.header('Access-Control-Allow-Origin', config.corsOrigin);
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.sendStatus(204);
        return;
      }
      next();
    });
  }

  const proxy = new RpcProxy(relayer, config.rpcUrl);

  app.get('/info', async (_req: Request, res: Response) => {
    try {
      res.json(await relayer.info());
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/nonce/:address', async (req: Request, res: Response) => {
    try {
      const address = getAddress(req.params.address);
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
      res.status(400).json({ error: 'Se espera { "rawTx": "0x..." }' });
      return;
    }
    try {
      const result = await relayer.relay(rawTx);
      console.log(`[relay] ok ${result.transactionHash} from=${result.from} to=${result.to} executed=${result.executed}`);
      res.json(result);
    } catch (err) {
      if (err instanceof RelayError) {
        console.warn(`[relay] rechazada (${err.code}): ${err.message}`);
        res.status(400).json({ error: err.message, code: err.code, details: err.details ?? null });
        return;
      }
      console.error('[relay] error inesperado', err);
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/', async (req: Request, res: Response) => {
    try {
      const result = await proxy.handle(req.body);
      // Un batch de puras notificaciones no lleva cuerpo de respuesta.
      if (result === null) {
        res.sendStatus(204);
        return;
      }
      res.json(result);
    } catch (err) {
      console.error('[rpc] error inesperado', err);
      res.json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: (err as Error).message } });
    }
  });

  // Servidor HTTP explicito para poder colgarle el WebSocket en el mismo puerto.
  const server = createServer(app);
  attachWsProxy(server, proxy, config);

  server.listen(config.port, () => {
    console.log(`escuchando en http://localhost:${config.port}`);
    console.log(`websocket en   ws://localhost:${config.port}  (upstream ${config.wsUrl || 'no configurado'})`);
  });
}

main().catch((err) => {
  console.error('No se pudo arrancar el relayer:', err);
  process.exit(1);
});
