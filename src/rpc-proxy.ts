/**
 * Proxy JSON-RPC: un dapp apunta su provider aca y funciona sin cambios.
 *
 *   lecturas  -> passthrough crudo al nodo (eth_call, eth_getLogs, eth_blockNumber, ...)
 *   escrituras -> se relayan como metatx del modelo de gas
 *
 * Los tres metodos que no pueden ir crudos:
 *
 *   eth_sendRawTransaction  la raw tx es una metatx (chainId 0, gasPrice 0): el nodo la
 *                           rechazaria. Va al relayer y se devuelve el hash sin esperar el
 *                           receipt, que es lo que espera un cliente JSON-RPC.
 *   eth_getTransactionCount el nonce que importa es el del RelayHub, no el de la cuenta.
 *   eth_getTransactionReceipt  el receipt crudo es el de la tx del writer node al hub: dice
 *                           status 1 aunque la llamada del usuario haya revertido, y
 *                           contractAddress null en los deploys. Hay que reescribirlo.
 *
 * Los batches se parten y se rutean uno por uno: ethers v6 batchea por defecto, y reenviar el
 * body entero dejaria pasar un eth_sendRawTransaction derecho al nodo, saltandose el relayer.
 */
import { getAddress, isHexString } from 'ethers';
import { RelayError, Relayer } from './relayer';

export interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
/** Rango reservado para errores de aplicacion; es el que usa el relay-signer para BAD NONCE. */
const SERVER_ERROR = -32000;

function ok(id: unknown, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function fail(id: unknown, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

/** Una notificacion JSON-RPC (sin `id`) no lleva respuesta. */
function isNotification(req: JsonRpcRequest): boolean {
  return req.id === undefined;
}

export class RpcProxy {
  constructor(
    private readonly relayer: Relayer,
    private readonly upstreamUrl: string,
  ) {}

  /**
   * Punto de entrada. Acepta un request suelto o un batch y devuelve lo que hay que responder
   * (`null` si eran todas notificaciones, que no llevan cuerpo).
   */
  async handle(body: unknown): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
    if (Array.isArray(body)) {
      if (body.length === 0) return fail(null, INVALID_REQUEST, 'El batch no puede venir vacio');
      const responses = await this.handleBatch(body as JsonRpcRequest[]);
      return responses.length > 0 ? responses : null;
    }
    if (body === null || typeof body !== 'object') {
      return fail(null, PARSE_ERROR, 'El cuerpo tiene que ser un objeto o un array JSON-RPC');
    }
    const req = body as JsonRpcRequest;
    const res = await this.route(req);
    return isNotification(req) ? null : res;
  }

  /**
   * Rutea cada entrada del batch por separado, pero agrupa las de passthrough en UN solo batch
   * upstream: partir el batch no tiene que costar N round-trips al nodo.
   */
  private async handleBatch(reqs: JsonRpcRequest[]): Promise<JsonRpcResponse[]> {
    const slots: (JsonRpcResponse | null)[] = new Array(reqs.length).fill(null);
    const forwarded: { index: number; req: JsonRpcRequest }[] = [];
    const local: Promise<void>[] = [];

    reqs.forEach((req, index) => {
      if (this.isPassthrough(req)) {
        forwarded.push({ index, req });
      } else {
        local.push(
          this.route(req).then((res) => {
            slots[index] = res;
          }),
        );
      }
    });

    await Promise.all([
      ...local,
      forwarded.length > 0
        ? this.forwardBatch(forwarded).then((byIndex) => {
            for (const [index, res] of byIndex) slots[index] = res;
          })
        : Promise.resolve(),
    ]);

    // Las notificaciones no van en la respuesta.
    return reqs.map((req, i) => (isNotification(req) ? null : slots[i])).filter((r): r is JsonRpcResponse => r !== null);
  }

  /** true si el metodo va crudo al nodo (o sea: todo lo que no interceptamos). */
  private isPassthrough(req: JsonRpcRequest): boolean {
    switch (req.method) {
      case 'eth_sendRawTransaction':
      case 'eth_getTransactionCount':
      case 'eth_getTransactionReceipt':
      case 'eth_sendTransaction':
      case 'eth_sign':
      case 'eth_signTransaction':
      case 'eth_accounts':
      case 'eth_requestAccounts':
        return false;
      default:
        return true;
    }
  }

  private async route(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { id, method } = req;
    if (typeof method !== 'string') {
      return fail(id, INVALID_REQUEST, 'Falta el campo "method"');
    }
    const params = Array.isArray(req.params) ? req.params : [];

    try {
      switch (method) {
        case 'eth_sendRawTransaction':
          return await this.sendRawTransaction(id, params);
        case 'eth_getTransactionCount':
          return await this.getTransactionCount(id, params);
        case 'eth_getTransactionReceipt':
          return await this.getTransactionReceipt(id, params);

        // El relayer no custodia claves de usuario: el dapp firma la metatx del lado del cliente.
        case 'eth_sendTransaction':
        case 'eth_sign':
        case 'eth_signTransaction':
          return fail(
            id,
            METHOD_NOT_FOUND,
            `${method} no esta soportado: el relayer no tiene la clave del usuario. ` +
              'Firma la metatx en el cliente y mandala con eth_sendRawTransaction.',
          );
        case 'eth_accounts':
        case 'eth_requestAccounts':
          return ok(id, []);

        default:
          return await this.forward(req);
      }
    } catch (err) {
      if (err instanceof RelayError) {
        return fail(id, SERVER_ERROR, `${err.code}: ${err.message}`, err.details ?? undefined);
      }
      return fail(id, INTERNAL_ERROR, (err as Error).message);
    }
  }

  // ---------------------------------------------------------------- escrituras

  private async sendRawTransaction(id: unknown, params: unknown[]): Promise<JsonRpcResponse> {
    const rawTx = params[0];
    if (typeof rawTx !== 'string' || !isHexString(rawTx)) {
      return fail(id, INVALID_PARAMS, 'params[0] tiene que ser la raw tx en hex');
    }
    // Sin esperar el receipt: el dapp lo va a polear con eth_getTransactionReceipt.
    const submitted = await this.relayer.submitRelay(rawTx);
    console.log(
      `[rpc] relay enviada ${submitted.transactionHash} from=${submitted.from} ` +
        `to=${submitted.to ?? '(deploy)'} nonce=${submitted.nonce}`,
    );
    return ok(id, submitted.transactionHash);
  }

  // ---------------------------------------------------------------- lecturas interceptadas

  private async getTransactionCount(id: unknown, params: unknown[]): Promise<JsonRpcResponse> {
    const address = params[0];
    if (typeof address !== 'string') {
      return fail(id, INVALID_PARAMS, 'params[0] tiene que ser una address');
    }
    // "latest" -> lo minado; "pending" (o sin bloque) -> contando lo que el relayer tiene en vuelo,
    // que es el equivalente al nonce pending de una cuenta normal y lo que hay que firmar.
    const user = getAddress(address);
    const nonce = params[1] === 'latest' ? await this.relayer.getNonce(user) : await this.relayer.nextNonce(user);
    return ok(id, '0x' + nonce.toString(16));
  }

  private async getTransactionReceipt(id: unknown, params: unknown[]): Promise<JsonRpcResponse> {
    const hash = params[0];
    if (typeof hash !== 'string') {
      return fail(id, INVALID_PARAMS, 'params[0] tiene que ser un hash');
    }
    const upstream = await this.forward({ jsonrpc: '2.0', id, method: 'eth_getTransactionReceipt', params: [hash] });
    if (upstream.error !== undefined || upstream.result == null) return upstream;
    return ok(id, this.relayer.enrichReceipt(upstream.result as Record<string, any>));
  }

  // ---------------------------------------------------------------- passthrough

  private async forward(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const [res] = await this.postUpstream([{ ...req, jsonrpc: '2.0', id: req.id ?? 0 }]);
    return res ?? fail(req.id, INTERNAL_ERROR, 'El nodo no devolvio respuesta');
  }

  private async forwardBatch(entries: { index: number; req: JsonRpcRequest }[]): Promise<[number, JsonRpcResponse][]> {
    // Se reindexa el batch antes de mandarlo: los ids del dapp pueden repetirse o faltar, y la
    // respuesta del nodo viene sin orden garantizado, asi que hay que poder mapearla de vuelta.
    const payload = entries.map((entry, i) => ({ ...entry.req, jsonrpc: '2.0' as const, id: i }));
    const responses = await this.postUpstream(payload);

    const byLocalId = new Map<number, JsonRpcResponse>();
    for (const res of responses) {
      if (typeof res?.id === 'number') byLocalId.set(res.id, res);
    }
    return entries.map((entry, i) => {
      const res = byLocalId.get(i) ?? fail(entry.req.id, INTERNAL_ERROR, 'El nodo no devolvio respuesta');
      return [entry.index, { ...res, id: entry.req.id ?? null }];
    });
  }

  private async postUpstream(payload: JsonRpcRequest[]): Promise<JsonRpcResponse[]> {
    let res: Response;
    try {
      res = await fetch(this.upstreamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Un solo request se manda suelto: hay nodos que no aceptan batches.
        body: JSON.stringify(payload.length === 1 ? payload[0] : payload),
      });
    } catch (err) {
      throw new Error(`no se pudo hablar con el nodo: ${(err as Error).message}`);
    }
    if (!res.ok) throw new Error(`el nodo devolvio HTTP ${res.status}`);

    const body = await res.json();
    return Array.isArray(body) ? (body as JsonRpcResponse[]) : [body as JsonRpcResponse];
  }
}
