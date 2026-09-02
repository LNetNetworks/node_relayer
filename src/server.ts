/**
 * Arranque local del relayer: proceso persistente que escucha en un puerto.
 *
 * Las rutas viven en `src/app.ts`, compartidas con el despliegue serverless (`api/index.ts`).
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
import { createServer } from 'http';
import { assertConfigComplete, config } from './config';
import { createRelayApp } from './app';
import { attachWsProxy } from './ws-proxy';

async function main() {
  // En local conviene el fallo temprano y claro, antes de abrir el puerto.
  assertConfigComplete();

  const { app, ready } = createRelayApp(config);

  // Local conviene fallar en el arranque y no en la primera request.
  const { relayer, proxy } = await ready();
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

  // Servidor HTTP explicito para poder colgarle el WebSocket en el mismo puerto.
  const server = createServer(app);
  attachWsProxy(server, proxy, config);

  server.listen(config.port, () => {
    console.log(`escuchando en http://localhost:${config.port}`);
    if (config.dashboardEnabled) {
      console.log(`dashboard en    http://localhost:${config.port}/dashboard`);
    }
    console.log(`websocket en   ws://localhost:${config.port}  (upstream ${config.wsUrl || 'no configurado'})`);
  });
}

main().catch((err) => {
  console.error('Could not start the relayer:', err);
  process.exit(1);
});
