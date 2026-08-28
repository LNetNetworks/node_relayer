/**
 * Entrypoint serverless (Vercel).
 *
 * Se exporta el `http.Server` en vez de un handler para poder colgarle el WebSocket: es el
 * patron que Vercel documenta para `ws` sobre Fluid Compute.
 *
 * ADVERTENCIA: este relayer fue disenado para correr como instancia unica (ver "Supuesto: una
 * sola instancia" en el README). El tracker de nonces vive en memoria del proceso, asi que si
 * Vercel escala a mas de una instancia dos de ellas pueden firmar el mismo nonce con la misma
 * clave de writer node. Desplegado aca a sabiendas.
 */
import { createServer } from 'http';
import { config } from '../src/config';
import { createRelayApp } from '../src/app';
import { attachWsProxy } from '../src/ws-proxy';

const { app, ready } = createRelayApp(config);
const server = createServer(app);

// El proxy va como getter: al montar el WS el relayer todavia no se inicializo (lo hace en la
// primera request, para no convertir un problema de red en un fallo de cold start).
attachWsProxy(server, async () => (await ready()).proxy, config);

export default server;
