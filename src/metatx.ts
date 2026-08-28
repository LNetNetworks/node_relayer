/**
 * Lado cliente: arma y firma la metatx del modelo de gas LAC-NET y se la manda al relayer.
 *
 * No usa @lacchain/gas-model-provider a proposito: son ~40 lineas y asi se ve exactamente
 * que se firma. Ojo con el gotcha de ethers: `Wallet.signTransaction` no sirve para esto
 * (valida chainId contra la red), hay que firmar `tx.unsignedHash` con el signingKey.
 *
 * Dos transportes para mandar la metatx, mismo nucleo de firma y de nonces:
 *
 *   'rest' (default)  POST /relay, que responde recien cuando la metatx se mino y trae el
 *                     resultado ya decodificado (executed, eventos, output, si se simulo).
 *   'rpc'             el proxy JSON-RPC (POST /), que es por donde entra un dapp real:
 *                     eth_sendRawTransaction devuelve el hash al toque y hay que polear
 *                     eth_getTransactionReceipt, igual que contra un nodo. El resultado sale
 *                     del receipt reescrito por el relayer, asi que se ve menos (no hay
 *                     `simulated` ni eventos) pero se ejerce el camino del dapp.
 */
import { Interface, InterfaceAbi, Transaction, Wallet, getAddress } from 'ethers';
import { appendGasModelSuffix, expirationFromNow, metaTxGasLimit } from './gas-model';

export interface RelayerInfo {
  nodeAddress: string;
  relayHubAddress: string;
  chainId: string;
}

export interface RelayErrorBody {
  error?: string;
  code?: string;
  details?: { expected?: number; got?: number } | null;
}

export interface RelayResponse {
  transactionHash: string;
  from: string;
  to: string | null;
  /** Nonce del RelayHub con el que se firmo la metatx (no el de la cuenta). */
  nonce: number;
  isDeploy: boolean;
  deployedAddress: string | null;
  blockNumber: number | null;
  executed: boolean | null;
  errorCodeName: string | null;
  /**
   * false = el relayer la mando sin pre-chequeo por venir encadenada sobre otra en vuelo.
   * undefined por el transporte 'rpc': el receipt no dice si hubo simulacion.
   */
  simulated?: boolean;
  output: string | null;
  gasUsed: string;
  /** Eventos del hub. Vacio por el transporte 'rpc': el receipt viene sin decodificar. */
  events: string[];
}

/** Error JSON-RPC tal cual lo devuelve el proxy. */
export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

/** Una llamada JSON-RPC cruda: devuelve `error` en vez de tirarlo, para poder mirarle el codigo. */
export async function rpcRequest<T = any>(
  url: string,
  method: string,
  params: unknown[],
): Promise<{ result?: T; error?: JsonRpcErrorBody }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return (await res.json()) as { result?: T; error?: JsonRpcErrorBody };
}

export async function rpcCall<T = any>(url: string, method: string, params: unknown[]): Promise<T> {
  const body = await rpcRequest<T>(url, method, params);
  if (body.error) throw new Error(`${method} failed: ${body.error.message} (code ${body.error.code})`);
  return body.result as T;
}

function relayFailure(status: number, body: RelayErrorBody): Error {
  return new Error(`The relayer rejected the metatx [${body.code ?? status}]: ${body.error}`);
}

/**
 * El proxy serializa los RelayError como `-32000` con el mensaje `CODIGO: detalle`. Se le saca
 * el codigo de vuelta para que el caller vea lo mismo que por REST (p.ej. BAD_NONCE, que es el
 * unico que el cliente reintenta).
 */
function relayErrorFromRpc(err: JsonRpcErrorBody): RelayErrorBody {
  const match = /^([A-Z][A-Z_]*): ([\s\S]*)$/.exec(err.message);
  if (match === null) return { code: `RPC_${err.code}`, error: err.message };
  return { code: match[1], error: match[2], details: err.data as RelayErrorBody['details'] };
}

type PostResult =
  | { ok: true; body: RelayResponse }
  | { ok: false; status: number; body: RelayErrorBody };

export class MetaTxClient {
  readonly wallet: Wallet;
  /** Se cachea la promesa, no el resultado: si no, N `sign()` concurrentes hacen N GET /info. */
  private cachedInfo: Promise<RelayerInfo> | null = null;

  /**
   * Cursor local de nonces. Sin esto, N `send()` concurrentes leen el mismo `/nonce` y firman
   * todos el mismo valor. El cursor los reparte de a uno para poder encadenar metatx.
   */
  private nextLocalNonce: number | null = null;
  /** Serializa la asignacion del cursor (y su resincronizacion). */
  private nonceQueue: Promise<unknown> = Promise.resolve();
  /** Sube cada vez que se invalida el cursor, para que N reintentos hagan un solo refetch. */
  private nonceGeneration = 0;

  constructor(
    privateKey: string,
    readonly relayerUrl: string,
    readonly opts: {
      expirationSeconds?: number;
      gasMargin?: number;
      nonceRetries?: number;
      /** 'rest' = POST /relay; 'rpc' = proxy JSON-RPC (lo que usa un dapp). Default 'rest'. */
      transport?: 'rest' | 'rpc';
      /** Solo transporte 'rpc': techo de espera del receipt y cada cuanto se polea. */
      receiptTimeoutMs?: number;
      receiptPollMs?: number;
    } = {},
  ) {
    // Sin provider: la metatx se firma offline y se manda al relayer por HTTP.
    this.wallet = new Wallet(privateKey);
  }

  get address(): string {
    return this.wallet.address;
  }

  async info(): Promise<RelayerInfo> {
    if (this.cachedInfo === null) {
      this.cachedInfo = (async () => {
        const res = await fetch(new URL('/info', this.relayerUrl));
        if (!res.ok) throw new Error(`GET /info returned ${res.status}`);
        return (await res.json()) as RelayerInfo;
      })();
      this.cachedInfo.catch(() => {
        this.cachedInfo = null; // no dejar cacheado un fallo
      });
    }
    return this.cachedInfo;
  }

  /**
   * Proximo nonce a firmar dentro del RelayHub (no es el nonce de la cuenta). Usa `nextNonce`,
   * que ya cuenta las metatx que el relayer mando y siguen sin minarse.
   */
  async nonce(): Promise<number> {
    if (this.transport === 'rpc') {
      // El proxy intercepta eth_getTransactionCount y devuelve el nonce del hub, no el de la
      // cuenta: 'pending' cuenta lo que el relayer tiene en vuelo, que es lo que hay que firmar.
      return Number(await rpcCall<string>(this.relayerUrl, 'eth_getTransactionCount', [this.address, 'pending']));
    }
    const body = await this.getNonceBody();
    return Number(body.nextNonce ?? body.nonce);
  }

  /** Nonce confirmado en la cadena, sin contar lo que este en vuelo. */
  async minedNonce(): Promise<number> {
    if (this.transport === 'rpc') {
      return Number(await rpcCall<string>(this.relayerUrl, 'eth_getTransactionCount', [this.address, 'latest']));
    }
    return Number((await this.getNonceBody()).nonce);
  }

  /**
   * Metatx mandadas por el relayer y todavia sin receipt.
   *
   * Por 'rpc' no hay endpoint que lo diga: se deduce como pending - latest. Da lo mismo que el
   * contador del relayer una vez que la rafaga termino (que es cuando interesa mirarlo); en el
   * medio puede diferir, porque el relayer se guarda la cadena unos ms despues del ultimo receipt.
   */
  async pendingCount(): Promise<number> {
    if (this.transport === 'rpc') {
      const [pending, mined] = await Promise.all([this.nonce(), this.minedNonce()]);
      return pending - mined;
    }
    return Number((await this.getNonceBody()).pending ?? 0);
  }

  private get transport(): 'rest' | 'rpc' {
    return this.opts.transport ?? 'rest';
  }

  private async getNonceBody(): Promise<{ nonce: string; nextNonce?: string; pending?: number }> {
    const res = await fetch(new URL(`/nonce/${this.address}`, this.relayerUrl));
    if (!res.ok) throw new Error(`GET /nonce returned ${res.status}`);
    return (await res.json()) as { nonce: string; nextNonce?: string; pending?: number };
  }

  /** eth_estimateGas del call original (sin el sufijo), con margen. `to` null = deploy. */
  async estimateGas(to: string | null, data: string): Promise<bigint> {
    const tx: Record<string, string> = { from: this.address, data, gasPrice: '0x0', value: '0x0' };
    if (to != null) tx.to = getAddress(to);
    const hex = await rpcCall<string>(this.relayerUrl, 'eth_estimateGas', [tx]);
    const margin = this.opts.gasMargin ?? 1.3;
    return (BigInt(hex) * BigInt(Math.round(margin * 100))) / 100n;
  }

  /** eth_call de lectura, va por el passthrough del relayer. */
  async read(to: string, signature: string, args: unknown[] = []): Promise<any> {
    const iface = new Interface([`function ${signature}`]);
    const fn = iface.fragments[0];
    const data = iface.encodeFunctionData(fn as any, args);
    const raw = await rpcCall<string>(this.relayerUrl, 'eth_call', [{ to: getAddress(to), data }, 'latest']);
    return iface.decodeFunctionResult(fn as any, raw);
  }

  /** Firma la metatx: chainId 0, gasPrice 0, value 0, data + (nodeAddress, expiration). */
  async sign(params: { to: string | null; data: string; gasLimit?: bigint; nonce?: number }): Promise<{
    rawTx: string;
    nonce: number;
    gasLimit: bigint;
    metaTxGasLimit: bigint;
    expiration: number;
    nodeAddress: string;
  }> {
    const { nodeAddress } = await this.info();
    const to = params.to == null ? null : getAddress(params.to);
    const nonce = params.nonce ?? (await this.nonce());
    const gasLimit = params.gasLimit ?? (await this.estimateGas(to, params.data));
    const expiration = expirationFromNow(this.opts.expirationSeconds ?? 86_400);
    const data = appendGasModelSuffix(params.data, nodeAddress, expiration);

    const tx = Transaction.from({
      type: 0,
      chainId: 0,
      nonce,
      gasPrice: 0,
      gasLimit,
      to,
      value: 0,
      data,
    });
    tx.signature = this.wallet.signingKey.sign(tx.unsignedHash);

    return {
      rawTx: tx.serialized,
      nonce,
      gasLimit,
      metaTxGasLimit: metaTxGasLimit(data, gasLimit),
      expiration,
      nodeAddress,
    };
  }

  /** Reserva el proximo nonce local, resincronizando contra el relayer si hace falta. */
  private allocNonce(): Promise<{ nonce: number; generation: number }> {
    const run = this.nonceQueue.then(async () => {
      if (this.nextLocalNonce === null) this.nextLocalNonce = await this.nonce();
      return { nonce: this.nextLocalNonce++, generation: this.nonceGeneration };
    });
    this.nonceQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * Tira el cursor para que la proxima asignacion relea del relayer. `generation` evita que
   * varios reintentos concurrentes lo invaliden en cadena: solo el primero cuenta.
   */
  private invalidateNonce(generation: number): Promise<void> {
    const run = this.nonceQueue.then(() => {
      if (generation !== this.nonceGeneration) return;
      this.nonceGeneration += 1;
      this.nextLocalNonce = null;
    });
    this.nonceQueue = run.catch(() => undefined);
    return run;
  }

  /** Fuerza la resincronizacion del cursor local contra el relayer. */
  async resetNonce(): Promise<void> {
    return this.invalidateNonce(this.nonceGeneration);
  }

  /** Manda la metatx por el transporte configurado. No tira: el error viaja en el resultado. */
  private async postRelay(rawTx: string): Promise<PostResult> {
    return this.transport === 'rpc' ? this.postRelayRpc(rawTx) : this.postRelayRest(rawTx);
  }

  private async postRelayRest(rawTx: string): Promise<PostResult> {
    const res = await fetch(new URL('/relay', this.relayerUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rawTx }),
    });
    const body = (await res.json()) as RelayResponse & RelayErrorBody;
    return res.ok ? { ok: true, body } : { ok: false, status: res.status, body };
  }

  /**
   * Camino del dapp: eth_sendRawTransaction devuelve el hash apenas la tx entra al txpool, y el
   * resultado de la metatx sale de polear eth_getTransactionReceipt. El receipt ya viene
   * reescrito por el relayer (status 0 si la llamada del usuario revirtio, contractAddress en
   * los deploys), asi que alcanza para saber si se ejecuto.
   */
  private async postRelayRpc(rawTx: string): Promise<PostResult> {
    const tx = Transaction.from(rawTx);
    const sent = await rpcRequest<string>(this.relayerUrl, 'eth_sendRawTransaction', [rawTx]);
    if (sent.error !== undefined) {
      return { ok: false, status: 400, body: relayErrorFromRpc(sent.error) };
    }
    const hash = sent.result as string;

    const timeoutMs = this.opts.receiptTimeoutMs ?? 60_000;
    const receipt = await this.waitForReceipt(hash, timeoutMs);
    if (receipt === null) {
      return {
        ok: false,
        status: 504,
        // Mismo codigo que usa el relayer cuando se le vence la espera, para que el caller no
        // tenga que distinguir de que lado se agoto el tiempo.
        body: { code: 'RECEIPT_TIMEOUT', error: `metatx ${hash} was not mined within ${timeoutMs} ms` },
      };
    }

    return {
      ok: true,
      body: {
        transactionHash: hash,
        from: tx.from!,
        to: tx.to,
        nonce: tx.nonce,
        isDeploy: tx.to == null,
        deployedAddress: (receipt.contractAddress as string) ?? null,
        blockNumber: Number(receipt.blockNumber),
        executed: receipt.status === '0x1',
        errorCodeName: (receipt.relayErrorCodeName as string) ?? null,
        output: (receipt.revertReason as string) ?? null,
        gasUsed: BigInt(receipt.gasUsed ?? 0).toString(),
        events: [],
      },
    };
  }

  /** Polea el receipt hasta que aparezca o se venza el techo. null = no se mino a tiempo. */
  private async waitForReceipt(hash: string, timeoutMs: number): Promise<Record<string, any> | null> {
    const pollMs = this.opts.receiptPollMs ?? 200;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const receipt = await rpcCall<Record<string, any> | null>(this.relayerUrl, 'eth_getTransactionReceipt', [hash]);
      if (receipt != null) return receipt;
      if (Date.now() >= deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /**
   * Firma y manda la metatx al relayer. `to` null = deploy (el hub usa deployMetaTx).
   *
   * Se puede llamar varias veces en paralelo: el cursor local reparte nonces consecutivos y el
   * relayer los encadena, asi que entran varias metatx del mismo usuario en un mismo bloque.
   * Ante BAD_NONCE (cursor desfasado por otro cliente, o cadena rota en el relayer) se tira el
   * cursor y se refirma una vez. Si el caller fijo el nonce a mano no reintentamos: lo eligio a
   * proposito y cambiarselo seria peor que el error.
   */
  async send(params: { to: string | null; data: string; gasLimit?: bigint; nonce?: number }): Promise<RelayResponse> {
    if (params.nonce !== undefined) {
      const pinned = await this.sign(params);
      const res = await this.postRelay(pinned.rawTx);
      if (!res.ok) throw relayFailure(res.status, res.body);
      return res.body;
    }

    // Un solo reintento no alcanza si otro cliente esta consumiendo nonces de la misma cuenta:
    // el nonce resincronizado puede volver a estar tomado. Con unos pocos intentos converge.
    const attempts = 1 + (this.opts.nonceRetries ?? 3);
    let alloc = await this.allocNonce();
    let gasLimit = params.gasLimit;
    let failure!: { status: number; body: RelayErrorBody };

    for (let attempt = 0; attempt < attempts; attempt++) {
      const signed = await this.sign({ ...params, nonce: alloc.nonce, gasLimit });
      gasLimit = signed.gasLimit; // no reestimar en los reintentos: solo cambia el nonce
      const res = await this.postRelay(signed.rawTx);
      if (res.ok) return res.body;
      failure = res;
      if (res.body.code !== 'BAD_NONCE') break;

      await this.invalidateNonce(alloc.generation);
      if (attempt < attempts - 1) alloc = await this.allocNonce();
    }

    // El cursor puede haber quedado adelantado respecto del relayer; que la proxima relea.
    await this.invalidateNonce(alloc.generation);
    throw relayFailure(failure.status, failure.body);
  }

  /**
   * Despliega un contrato por metatx: initcode = bytecode + args del constructor.
   *
   * Nota del modelo de gas: al initcode se le agregan igual los 64 bytes de
   * (nodeAddress, expiration). Solidity ignora los bytes extra al decodificar los
   * argumentos del constructor, asi que el deploy funciona sin tocar el contrato.
   */
  async deploy(params: {
    bytecode: string;
    abi?: InterfaceAbi;
    args?: unknown[];
    gasLimit?: bigint;
  }): Promise<RelayResponse> {
    let initcode = params.bytecode.startsWith('0x') ? params.bytecode : '0x' + params.bytecode;
    if (params.args?.length) {
      if (!params.abi) throw new Error('Passing constructor args requires the abi');
      const iface = new Interface(params.abi);
      initcode += iface.encodeDeploy(params.args).slice(2);
    }
    return this.send({ to: null, data: initcode, gasLimit: params.gasLimit });
  }

  /** Azucar: manda una llamada a una funcion por firma humana, p.ej. 'store(uint256)'. */
  async call(to: string, signature: string, args: unknown[] = [], gasLimit?: bigint): Promise<RelayResponse> {
    const iface = new Interface([`function ${signature}`]);
    const data = iface.encodeFunctionData(iface.fragments[0] as any, args);
    return this.send({ to, data, gasLimit });
  }
}
