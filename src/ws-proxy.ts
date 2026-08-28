/**
 * Proxy JSON-RPC sobre WebSocket, para dapps que usan `WebSocketProvider` o `eth_subscribe`.
 *
 * Es el mismo ruteo que en HTTP (lecturas al nodo, escrituras como metatx) mas los dos metodos
 * que solo existen sobre un socket: `eth_subscribe` y `eth_unsubscribe`.
 *
 * Cada cliente tiene su PROPIA conexion al WS del nodo, abierta en la primera suscripcion. Es a
 * proposito: con un upstream compartido habria que reescribir los ids de suscripcion y llevar
 * refcount por topico (dos clientes suscriptos a newHeads comparten una sola suscripcion arriba,
 * y el unsubscribe de uno le cortaria el feed al otro). Con un upstream por cliente los ids son
 * 1:1, las notificaciones se reenvian tal cual y cerrar el cliente limpia todo solo.
 * El costo es una conexion al nodo por dapp conectado.
 */
import { IncomingMessage, Server } from 'http';
import { WebSocket, WebSocketServer } from 'ws';
import type { Config } from './config';
import { JsonRpcResponse, RpcProxy } from './rpc-proxy';

const INVALID_REQUEST = -32600;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const PARSE_ERROR = -32700;

function fail(id: unknown, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** Estado de un dapp conectado. */
class WsSession {
  /** Conexion al WS del nodo. Se abre recien en la primera suscripcion. */
  private upstream: WebSocket | null = null;
  private upstreamReady: Promise<WebSocket> | null = null;
  /** id que le mandamos al nodo -> que pidio el cliente, para mapear la respuesta de vuelta. */
  private readonly pending = new Map<number, { clientId: unknown; method: string; params: unknown[] }>();
  private nextId = 1;
  /** Suscripciones vivas, para poder loguear y para saber si vale la pena reconectar. */
  private readonly subscriptions = new Set<string>();
  private closed = false;

  constructor(
    private readonly client: WebSocket,
    private readonly getProxy: () => Promise<RpcProxy>,
    private readonly wsUrl: string,
    private readonly connectTimeoutMs: number,
    private readonly label: string,
  ) {}

  async onMessage(raw: string): Promise<void> {
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      this.reply(fail(null, PARSE_ERROR, 'Invalid JSON'));
      return;
    }

    // Un batch puede mezclar suscripciones con el resto, asi que se rutea entrada por entrada.
    if (Array.isArray(body)) {
      if (body.length === 0) {
        this.reply(fail(null, INVALID_REQUEST, 'The batch cannot be empty'));
        return;
      }
      const out = (await Promise.all(body.map((entry) => this.routeOne(entry)))).filter(
        (r): r is JsonRpcResponse => r !== null,
      );
      if (out.length > 0) this.reply(out);
      return;
    }

    const res = await this.routeOne(body);
    if (res !== null) this.reply(res);
  }

  private async routeOne(body: unknown): Promise<JsonRpcResponse | null> {
    if (body === null || typeof body !== 'object') {
      return fail(null, INVALID_REQUEST, 'Each entry must be a JSON-RPC object');
    }
    const req = body as { id?: unknown; method?: unknown; params?: unknown };

    if (req.method === 'eth_subscribe' || req.method === 'eth_unsubscribe') {
      // Sin id no hay a quien responderle la suscripcion, y sin respuesta no hay id de suscripcion.
      if (req.id === undefined) return null;
      return this.forwardToUpstream(req);
    }

    // Todo lo demas es identico a HTTP: se reusa el mismo dispatcher ya probado.
    const res = await (await this.getProxy()).handle(req);
    return Array.isArray(res) ? (res[0] ?? null) : res;
  }

  /** Manda `eth_subscribe`/`eth_unsubscribe` al nodo y espera su respuesta. */
  private async forwardToUpstream(req: { id?: unknown; method?: unknown; params?: unknown }): Promise<JsonRpcResponse> {
    if (this.wsUrl === '') {
      return fail(
        req.id,
        INVALID_PARAMS,
        `${String(req.method)} is not available: the relayer has no node WS configured (WS_URL).`,
      );
    }

    let upstream: WebSocket;
    try {
      upstream = await this.connectUpstream();
    } catch (err) {
      return fail(req.id, INTERNAL_ERROR, `could not open the node WS: ${(err as Error).message}`);
    }

    // Se reindexa: los ids del dapp pueden repetirse o ser strings, y hay que poder mapear la
    // respuesta del nodo de vuelta al request original.
    const localId = this.nextId++;
    const method = String(req.method);
    const params = Array.isArray(req.params) ? req.params : [];
    this.pending.set(localId, { clientId: req.id, method, params });
    upstream.send(JSON.stringify({ jsonrpc: '2.0', id: localId, method, params }));

    return new Promise<JsonRpcResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(localId);
        resolve(fail(req.id, INTERNAL_ERROR, `the node did not answer ${String(req.method)}`));
      }, 15_000);
      this.waiters.set(localId, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
    });
  }

  private readonly waiters = new Map<number, (res: JsonRpcResponse) => void>();

  private connectUpstream(): Promise<WebSocket> {
    if (this.upstreamReady !== null) return this.upstreamReady;

    this.upstreamReady = new Promise<WebSocket>((resolve, reject) => {
      // handshakeTimeout cubre el handshake HTTP; el timer cubre el connect TCP, que si no se
      // va al timeout del SO (~75 s) y deja al dapp colgado esperando su eth_subscribe.
      const socket = new WebSocket(this.wsUrl, { handshakeTimeout: this.connectTimeoutMs });
      const giveUp = setTimeout(() => {
        socket.terminate();
        reject(new Error(`no answer within ${this.connectTimeoutMs} ms`));
      }, this.connectTimeoutMs);

      const onOpenError = (err: Error) => {
        clearTimeout(giveUp);
        reject(err);
      };

      socket.once('error', onOpenError);
      socket.once('open', () => {
        clearTimeout(giveUp);
        socket.off('error', onOpenError);
        this.upstream = socket;
        console.log(`[ws] ${this.label} abrio upstream ${this.wsUrl}`);
        resolve(socket);
      });

      socket.on('message', (data) => this.onUpstreamMessage(String(data)));
      socket.on('close', () => this.onUpstreamGone('the node WS closed the connection'));
      socket.on('error', (err) => this.onUpstreamGone(`node WS error: ${err.message}`));
    });

    // Un fallo al abrir no tiene que dejar cacheada una promesa rechazada para siempre.
    this.upstreamReady.catch(() => {
      this.upstreamReady = null;
    });
    return this.upstreamReady;
  }

  private onUpstreamMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Notificacion de suscripcion: se reenvia tal cual, los ids son 1:1 con este cliente.
    if (msg?.method === 'eth_subscription') {
      this.reply(msg);
      return;
    }

    const waiter = this.waiters.get(msg?.id);
    if (waiter === undefined) return;
    this.waiters.delete(msg.id);
    const req = this.pending.get(msg.id);
    this.pending.delete(msg.id);

    if (req?.method === 'eth_subscribe' && typeof msg.result === 'string') {
      this.subscriptions.add(msg.result);
    } else if (req?.method === 'eth_unsubscribe' && msg.result === true) {
      // Solo la que se dio de baja: el cliente puede tener varias vivas.
      this.subscriptions.delete(String(req.params[0]));
    }

    waiter({ ...msg, id: req?.clientId ?? null });
  }

  /**
   * Si se cae el upstream las suscripciones quedan muertas. En vez de dejar al dapp esperando
   * eventos que no van a llegar, le cerramos el socket: su provider reconecta y se resuscribe,
   * que es como se recupera de cualquier corte.
   */
  private onUpstreamGone(reason: string): void {
    if (this.closed) return;
    if (this.subscriptions.size === 0 && this.waiters.size === 0) {
      this.upstream = null;
      this.upstreamReady = null;
      return;
    }
    console.warn(`[ws] ${this.label} ${reason}; closing the client so it reconnects`);
    this.close();
    // 1012 = Service Restart: los clientes lo tratan como reconectable.
    try {
      this.client.close(1012, reason);
    } catch {
      /* el socket ya estaba cerrado */
    }
  }

  private reply(payload: unknown): void {
    if (this.client.readyState !== WebSocket.OPEN) return;
    this.client.send(JSON.stringify(payload));
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.values()) {
      waiter(fail(null, INTERNAL_ERROR, 'the connection was closed'));
    }
    this.waiters.clear();
    this.pending.clear();
    this.subscriptions.clear();
    if (this.upstream !== null) {
      try {
        this.upstream.close();
      } catch {
        /* ya cerrado */
      }
      this.upstream = null;
    }
    this.upstreamReady = null;
  }
}

/** Monta el endpoint WebSocket sobre el mismo servidor HTTP del relayer. */
/** El proxy puede venir como getter perezoso: en serverless todavia no existe al montar el WS. */
export function attachWsProxy(
  server: Server,
  proxy: RpcProxy | (() => Promise<RpcProxy>),
  cfg: Config,
): { wsUrl: string } {
  const getProxy = typeof proxy === 'function' ? proxy : async () => proxy;
  const wsUrl = cfg.wsUrl;
  const wss = new WebSocketServer({ server });
  let seq = 0;

  wss.on('connection', (client: WebSocket, req: IncomingMessage) => {
    const label = `#${++seq} ${req.socket.remoteAddress ?? '?'}`;
    const session = new WsSession(client, getProxy, wsUrl, cfg.wsConnectTimeoutMs, label);
    console.log(`[ws] ${label} conectado`);

    client.on('message', (data) => {
      session.onMessage(String(data)).catch((err) => {
        console.error(`[ws] ${label} error procesando mensaje`, err);
      });
    });
    client.on('close', () => {
      session.close();
      console.log(`[ws] ${label} desconectado`);
    });
    client.on('error', () => session.close());
  });

  return { wsUrl };
}
