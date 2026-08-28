/**
 * Nucleo del relayer.
 *
 * Recibe la metatx del usuario ya firmada (raw tx hex), la valida y la ejecuta llamando
 * a RelayHub.relayMetaTx(gasLimit, signingData, v, r, s) con la clave del writer node.
 */
import { Contract, LogDescription, Transaction, TransactionReceipt, Wallet, getAddress } from 'ethers';
import { AccountRules } from './account-rules';
import { Config, config as defaultConfig } from './config';
import { LnetProvider } from './provider';
import {
  decodeGasModelSuffix,
  metaTxGasLimit,
  validateMetaTxShape,
} from './gas-model';
import {
  ERROR_CODE_OK,
  errorCodeName,
  relayHubContract,
  resolveRelayHubAddress,
} from './relayhub';

/** Saca el mensaje util de un error de ethers/JSON-RPC, sin el volcado del payload. */
function upstreamMessage(err: any): string {
  return (
    err?.info?.error?.message ??
    err?.error?.message ??
    err?.shortMessage ??
    err?.message ??
    String(err)
  );
}

/**
 * `tx.wait()` con techo de tiempo. Si vence, el nonce del writer node quedo consumido por una tx
 * que nunca se mino: hay que mirar el txpool del nodo, no reintentar a ciegas.
 */
async function waitWithTimeout(
  sent: { hash: string; wait: () => Promise<TransactionReceipt | null> },
  timeoutMs: number,
): Promise<TransactionReceipt | null> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new RelayError(
            `La tx ${sent.hash} no se mino en ${timeoutMs} ms. El nonce del writer node quedo consumido: ` +
              'revisar el txpool del nodo antes de reintentar.',
            'RECEIPT_TIMEOUT',
            { transactionHash: sent.hash },
          ),
        ),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([sent.wait(), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cadena de metatx en vuelo de un usuario. Se identifica por referencia: si la cadena se rompe
 * y se descarta, los receipts atrasados no tienen que tocar la cadena nueva que la reemplace.
 */
interface InflightChain {
  /** Proximo nonce del hub libre para este usuario. */
  next: bigint;
  /** Metatx enviadas y sin receipt. */
  pending: number;
  /**
   * Borrado diferido cuando `pending` llega a 0. La cadena tiene que sobrevivir al ultimo
   * receipt: si se borra al instante, en medio de una rafaga `nextNonce` cae al nonce minado
   * y un reintento resincroniza a un nonce que otra metatx de la misma rafaga ya tomo.
   */
  expiry?: ReturnType<typeof setTimeout>;
}

/** Receipt tal como lo devuelve el nodo por JSON-RPC (sin normalizar por ethers). */
type RawReceipt = Record<string, any> | null;
interface RawLog {
  address: string;
  topics: string[];
  data: string;
}

/** Sender de la raw tx para elegir el lock, sin fallar: si no parsea, doRelay da el error lindo. */
function safeSender(rawTx: string): string | null {
  try {
    return Transaction.from(rawTx).from ?? null;
  } catch {
    return null;
  }
}

export class RelayError extends Error {
  constructor(
    message: string,
    readonly code: string = 'RELAY_ERROR',
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

export interface RelayResult {
  transactionHash: string;
  /** true si fue un deploy (to == null) y se uso deployMetaTx. */
  isDeploy: boolean;
  /** direccion del contrato creado, del evento ContractDeployed (solo en deploys). */
  deployedAddress: string | null;
  blockNumber: number | null;
  gasUsed: string;
  /** ErrorCode que devolvio el hub (8 = OK). Solo disponible si se simulo antes de enviar. */
  errorCode: number | null;
  errorCodeName: string | null;
  /** false = se envio sin pre-chequeo con eth_call (metatx encadenada sobre otra en vuelo). */
  simulated: boolean;
  /** true si el hub ejecuto la llamada al contrato destino y esta no revirtio. */
  executed: boolean | null;
  from: string;
  to: string | null;
  nonce: number;
  metaTxGasLimit: string;
  /** return data de la llamada al contrato destino (o el revert reason si fallo). */
  output: string | null;
  events: string[];
}

/** Lo que se sabe de una metatx apenas entra al txpool, antes de que se mine. */
export interface SubmittedRelay {
  transactionHash: string;
  from: string;
  to: string | null;
  nonce: number;
  isDeploy: boolean;
  /** Resuelve con el resultado decodificado cuando la metatx se mina. Se puede ignorar. */
  settled: Promise<RelayResult>;
}

export interface RelayerInfo {
  nodeAddress: string;
  relayHubAddress: string;
  relayHubSource: 'config' | 'proxy';
  relayHubProxyAddress: string | null;
  chainId: string;
  rpcUrl: string;
  nodeBalance: string;
  currentGasLimit: string | null;
  /** AccountRules de la cadena, o null si no lo expone (devnet sin permissioning). */
  accountRulesAddress: string | null;
  accountRulesSource: 'config' | 'ingress' | null;
  /** true/false segun AccountRules; null si no hay con que chequear. */
  nodePermitted: boolean | null;
  /** Si se exige que el usuario de la metatx tambien este permisionado. */
  enforceAccountRules: boolean;
  /** Ventana minima de expiration que acepta el relayer, en segundos (0 = no se valida). */
  minExpirationSeconds: number;
  /** Tolerancia con la que se aplica ese minimo: el piso real es la resta de los dos. */
  expirationToleranceSeconds: number;
  /** Metatx en vuelo que se le permiten a un mismo usuario antes de responder TOO_MANY_INFLIGHT. */
  maxInflightPerUser: number;
}

export class Relayer {
  /** Cola de la seccion critica del nonce del writer node: envuelve solo el `send`. */
  private nonceLock: Promise<unknown> = Promise.resolve();

  /**
   * Un *envio* a la vez por usuario (no un relay entero): serializa la reserva del nonce del
   * hub, no la espera del receipt. Asi el mismo usuario puede tener varias metatx en vuelo.
   */
  private userLocks = new Map<string, Promise<unknown>>();

  /**
   * Nonces del hub reservados por metatx ya enviadas y todavia sin receipt.
   *
   * `getNonce` solo sube cuando la tx se mina, asi que para pipelinear no alcanza con leer la
   * cadena: hay que contar lo que este relayer ya mando. Es autoritativo porque el mapping del
   * hub es `nonces[msg.sender][from]`, o sea que la casilla es de ESTE writer node y nadie mas
   * la toca.
   *
   * SUPUESTO DE DISENO: una sola instancia por clave de writer node. El tracker vive en memoria
   * del proceso; dos relayers compartiendo la clave se pisarian aca y en el nonce de la cuenta.
   * Para escalar horizontalmente hay que sacar el tracker del proceso o darle a cada instancia
   * su propio writer node.
   *
   * El orden se mantiene porque `withNonceLock` asigna los nonces de la cuenta del node en el
   * mismo orden en que se reservan los del hub, y las tx de una EOA se ejecutan en orden de
   * nonce: la metatx N se mina siempre antes que la N+1, aunque caigan en el mismo bloque.
   */
  private inflight = new Map<string, InflightChain>();

  /**
   * Metatx que llegaron adelantadas y esperan que se cierre el hueco de nonces. Sobre HTTP el
   * orden de llegada no esta garantizado, y el hub exige el nonce exacto: sin esto, de una
   * rafaga del mismo usuario se cae la que se adelanto.
   */
  private turnWaiters = new Map<string, Set<() => void>>();

  /**
   * Ultimo resultado de `accountPermitted(writer node)`. Se lee al arrancar para avisar temprano
   * y para poder explicar un "not authorized" del nodo cuando pasa. null = no se pudo chequear.
   */
  private nodePermitted: boolean | null = null;

  private constructor(
    readonly provider: LnetProvider,
    readonly wallet: Wallet,
    readonly hub: Contract,
    readonly relayHubAddress: string,
    readonly relayHubSource: 'config' | 'proxy',
    readonly chainId: bigint,
    readonly accountRules: AccountRules | null,
    readonly cfg: Config,
  ) {}

  static async create(cfg: Config = defaultConfig): Promise<Relayer> {
    const provider = new LnetProvider(cfg.rpcUrl);
    const network = await provider.getNetwork();
    const wallet = new Wallet(cfg.nodePrivateKey, provider);
    const { relayHubAddress, source } = await resolveRelayHubAddress(provider, {
      relayHubAddress: cfg.relayHubAddress,
      proxyAddress: cfg.relayHubProxyAddress,
    });
    const hub = relayHubContract(getAddress(relayHubAddress), wallet);
    const accountRules = await Relayer.resolveAccountRules(provider, cfg);
    const relayer = new Relayer(
      provider,
      wallet,
      hub,
      getAddress(relayHubAddress),
      source,
      network.chainId,
      accountRules,
      cfg,
    );
    await relayer.checkNodePermissioning();
    return relayer;
  }

  /**
   * Resuelve el AccountRules. Que la cadena no lo tenga no es un error (una devnet sin
   * permissioning), pero con `ENFORCE_ACCOUNT_RULES=true` si lo es: un allowlist que no se puede
   * leer no se puede aplicar, y arrancar igual seria dejar la puerta abierta creyendo lo contrario.
   */
  private static async resolveAccountRules(
    provider: LnetProvider,
    cfg: Config,
  ): Promise<AccountRules | null> {
    let rules: AccountRules | null = null;
    try {
      rules = await AccountRules.resolve(provider, {
        accountRulesAddress: cfg.accountRulesAddress,
        ingressAddress: cfg.accountIngressAddress,
        cacheMs: cfg.accountRulesCacheMs,
      });
    } catch (err) {
      if (cfg.enforceAccountRules) {
        throw new Error(
          `ENFORCE_ACCOUNT_RULES=true pero no se pudo resolver AccountRules: ${upstreamMessage(err)}`,
        );
      }
      console.warn(`[permissioning] no se pudo resolver AccountRules: ${upstreamMessage(err)}`);
      return null;
    }
    if (rules === null && cfg.enforceAccountRules) {
      throw new Error(
        'ENFORCE_ACCOUNT_RULES=true pero esta cadena no expone AccountRules ' +
          `(AccountIngress ${cfg.accountIngressAddress ?? 'sin configurar'}). ` +
          'Configura ACCOUNT_RULES_ADDRESS o apaga la validacion.',
      );
    }
    return rules;
  }

  get nodeAddress(): string {
    return this.wallet.address;
  }

  async info(): Promise<RelayerInfo> {
    const [balance, currentGasLimit, nodePermitted] = await Promise.all([
      this.provider.getBalance(this.nodeAddress),
      this.hub.getCurrentGasLimit().catch(() => null),
      this.accountRules?.permitted(this.nodeAddress).catch(() => null) ?? null,
    ]);
    // Mantiene fresco el estado que usa el hint de SEND_FAILED.
    if (nodePermitted !== null) this.nodePermitted = nodePermitted;
    return {
      nodeAddress: this.nodeAddress,
      relayHubAddress: this.relayHubAddress,
      relayHubSource: this.relayHubSource,
      relayHubProxyAddress: this.cfg.relayHubProxyAddress ?? null,
      chainId: this.chainId.toString(),
      rpcUrl: this.cfg.rpcUrl,
      nodeBalance: balance.toString(),
      currentGasLimit: currentGasLimit === null ? null : currentGasLimit.toString(),
      accountRulesAddress: this.accountRules?.address ?? null,
      accountRulesSource: this.accountRules?.source ?? null,
      nodePermitted,
      enforceAccountRules: this.cfg.enforceAccountRules,
      minExpirationSeconds: this.cfg.enforceExpiration ? this.cfg.minExpirationSeconds : 0,
      expirationToleranceSeconds: this.cfg.enforceExpiration ? this.cfg.expirationToleranceSeconds : 0,
      maxInflightPerUser: this.cfg.maxInflightPerUser,
    };
  }

  /**
   * Chequea que el writer node este dado de alta en AccountRules. No aborta el arranque: es el
   * nodo el que aplica el permissioning, y su configuracion puede no estar mirando este contrato.
   */
  private async checkNodePermissioning(): Promise<void> {
    if (this.accountRules === null) {
      console.warn('[permissioning] la cadena no expone AccountRules: no se chequea el writer node');
      return;
    }
    try {
      this.nodePermitted = await this.accountRules.permitted(this.nodeAddress);
    } catch (err) {
      console.warn(
        `[permissioning] no se pudo leer AccountRules (${this.accountRules.address}): ${upstreamMessage(err)}`,
      );
      return;
    }
    if (!this.nodePermitted) {
      console.warn(
        `[permissioning] ${this.nodeAddress} NO esta en AccountRules (${this.accountRules.address}): ` +
          'si el nodo aplica permissioning de cuentas va a rechazar todos los relayMetaTx con ' +
          '"not authorized". Hay que darlo de alta (addAccount) ademas de addNode en el hub.',
      );
    }
  }

  /**
   * Permissioning del usuario de la metatx, como lo hace el relay-signer en Go. Solo corre con
   * `ENFORCE_ACCOUNT_RULES=true`: en el modelo de gas el usuario no tiene por que estar
   * permisionado, asi que prenderlo es usar AccountRules de allowlist del relayer.
   */
  private async assertSenderPermitted(from: string): Promise<void> {
    const rules = this.accountRules;
    // create() aborta si se pidio enforcement sin AccountRules, asi que aca ya no puede ser null.
    if (rules === null) return;

    let permitted: boolean;
    try {
      permitted = await rules.permitted(from);
    } catch (err) {
      // Fail closed: si el allowlist no se puede leer, no se relaya.
      throw new RelayError(
        `No se pudo consultar AccountRules (${rules.address}): ${upstreamMessage(err)}`,
        'PERMISSIONING_UNAVAILABLE',
      );
    }
    if (!permitted) {
      throw new RelayError(
        `${from} no esta permisionado en AccountRules (${rules.address})`,
        'SENDER_NOT_PERMITTED',
        { accountRules: rules.address, account: from },
      );
    }
  }

  /**
   * Nonce del usuario dentro del RelayHub. El mapping es nonces[msg.sender][from],
   * asi que el eth_call TIENE que ir con from = writer node, si no devuelve el nonce de otro casillero.
   */
  async getNonce(user: string): Promise<bigint> {
    return this.hub.getNonce.staticCall(getAddress(user), { from: this.nodeAddress });
  }

  /**
   * Proximo nonce del hub que este relayer va a aceptar para `user`, contando lo que ya mando
   * y sigue sin minarse. Es lo que tiene que firmar el cliente para encadenar metatx.
   */
  async nextNonce(user: string): Promise<bigint> {
    const address = getAddress(user);
    return this.inflight.get(address)?.next ?? (await this.getNonce(address));
  }

  /** Cantidad de metatx enviadas y sin receipt para `user`. */
  pendingCount(user: string): number {
    return this.inflight.get(getAddress(user))?.pending ?? 0;
  }

  /**
   * Descarta lo que el relayer creia saber del usuario: la proxima metatx relee la cadena.
   * Se llama cuando la cadena de nonces se rompio o se termino de vaciar.
   */
  private forgetInflight(user: string): void {
    const chain = this.inflight.get(user);
    if (chain?.expiry !== undefined) clearTimeout(chain.expiry);
    this.inflight.delete(user);
    this.notifyTurn(user); // los que esperaban tienen que reevaluar contra la cadena
  }

  /** Despierta a las metatx adelantadas de `user` para que reevaluen su turno. */
  private notifyTurn(user: string): void {
    const waiters = this.turnWaiters.get(user);
    if (waiters === undefined) return;
    for (const wake of [...waiters]) wake();
    this.turnWaiters.delete(user);
  }

  /**
   * Retiene una metatx que llego antes de tiempo hasta que su nonce sea el proximo esperado.
   * Al vencer la ventana sigue igual y `submit` la rechaza con BAD_NONCE y el nonce correcto.
   *
   * La ventana mide **estancamiento**, no espera total: cada vez que la cadena avanza hacia este
   * nonce se renueva. Si midiera el total, una rafaga larga perderia la cola por reloj aunque todo
   * estuviera funcionando -- con 12 metatx a ~1 s de envio cada una, las ultimas se caen de una
   * ventana de 3 s mientras el hub va por la quinta.
   */
  private async awaitTurn(user: string, nonce: bigint): Promise<void> {
    let deadline = Date.now() + this.cfg.reorderWindowMs;
    let lastExpected: bigint | null = null;
    for (;;) {
      const expected = this.inflight.get(user)?.next ?? (await this.getNonce(user));
      if (nonce <= expected) return;

      if (lastExpected === null || expected > lastExpected) {
        lastExpected = expected;
        deadline = Date.now() + this.cfg.reorderWindowMs;
      }

      const remaining = deadline - Date.now();
      if (remaining <= 0) return;

      const waiters = this.turnWaiters.get(user) ?? new Set<() => void>();
      this.turnWaiters.set(user, waiters);
      if (waiters.size >= this.cfg.maxInflightPerUser) return; // no acumular esperas sin techo

      await new Promise<void>((resolve) => {
        const wake = () => {
          clearTimeout(timer);
          waiters.delete(wake);
          resolve();
        };
        const timer = setTimeout(wake, remaining);
        waiters.add(wake);
      });
    }
  }

  /**
   * Serializa solo `fn` contra el resto de los envios. Ethers resuelve el nonce del writer
   * node con eth_getTransactionCount(pending) adentro del send, y cuando el send resuelve la
   * tx ya esta en el txpool, asi que el siguiente send ya ve el nonce incrementado.
   */
  private withNonceLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.nonceLock.then(fn, fn);
    this.nonceLock = run.catch(() => undefined);
    return run;
  }

  /** Serializa `fn` contra los otros relays del mismo `user`, y libera la entrada al terminar. */
  private withUserLock<T>(user: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.userLocks.get(user) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const guard = run.catch(() => undefined);
    this.userLocks.set(user, guard);
    // Sin esto el Map crece con un entry por usuario que haya relayado alguna vez.
    guard.then(() => {
      if (this.userLocks.get(user) === guard) this.userLocks.delete(user);
    });
    return run;
  }

  /** Relaya y espera el receipt. Devuelve el resultado ya decodificado. */
  async relay(rawTx: string): Promise<RelayResult> {
    return (await this.submitRelay(rawTx)).settled;
  }

  /**
   * Relaya y devuelve el hash **sin esperar el receipt**, que es lo que espera un cliente
   * JSON-RPC de `eth_sendRawTransaction`: manda, recibe el hash y despues polea el receipt.
   * `settled` resuelve cuando la metatx se mina; el caller puede ignorarlo.
   */
  async submitRelay(rawTx: string): Promise<SubmittedRelay> {
    return this.doRelay(rawTx);
  }

  private async doRelay(rawTx: string): Promise<SubmittedRelay> {
    let tx: Transaction;
    try {
      tx = Transaction.from(rawTx);
    } catch (err) {
      throw new RelayError(`No se pudo deserializar la raw tx: ${(err as Error).message}`, 'BAD_RAW_TX');
    }

    const problems = validateMetaTxShape(tx);
    if (problems.length > 0) {
      throw new RelayError(`La metatx no cumple el modelo de gas: ${problems.join('; ')}`, 'BAD_META_TX', problems);
    }
    const from = tx.from!;
    const { nodeAddress, expiration } = decodeGasModelSuffix(tx.data);

    if (this.cfg.enforceNodeAddress && nodeAddress !== this.nodeAddress) {
      throw new RelayError(
        `La metatx apunta al node ${nodeAddress} y este relayer es ${this.nodeAddress}`,
        'WRONG_NODE_ADDRESS',
      );
    }
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (this.cfg.enforceExpiration) {
      if (expiration <= now) {
        throw new RelayError(`La metatx expiro (expiration=${expiration}, ahora=${now})`, 'EXPIRED');
      }
      // Una expiration al filo no sirve: entre validar, simular, esperar el turno del nonce y
      // minar pasan segundos, y si vence en el medio ya se gasto una tx del writer node.
      //
      // El minimo se aplica con tolerancia: quien firma `ahora + 300` no puede llegar con 300 s
      // (se pierde la latencia del POST y el floor a segundos de cada lado), asi que exigir el
      // valor exacto rechazaria justamente al cliente que hizo lo correcto.
      const remaining = expiration - now;
      const minimum = BigInt(this.cfg.minExpirationSeconds);
      const tolerance = BigInt(this.cfg.expirationToleranceSeconds);
      const floor = minimum > tolerance ? minimum - tolerance : 0n;
      if (remaining < floor) {
        throw new RelayError(
          `expiration too low: la metatx expira en ${remaining} s y el minimo es ${minimum} s ` +
            `(tolerancia ${tolerance} s por latencia; expiration=${expiration}, ahora=${now})`,
          'EXPIRATION_TOO_LOW',
          {
            expiration: Number(expiration),
            remainingSeconds: Number(remaining),
            minimumSeconds: Number(minimum),
            toleranceSeconds: Number(tolerance),
          },
        );
      }
    }
    // Antes de reservar nonce y de gastar la simulacion: si el sender no pasa, no hay nada mas que hacer.
    if (this.cfg.enforceAccountRules) await this.assertSenderPermitted(from);

    const signingData = tx.unsignedSerialized; // RLP([nonce, gasPrice, gasLimit, to, value, data])
    const { v, r, s } = tx.signature!;
    const gasLimit = metaTxGasLimit(tx.data, tx.gasLimit);
    const overrides = { gasLimit, gasPrice: 0n };

    const isDeploy = tx.to == null;
    const method = isDeploy ? 'deployMetaTx' : 'relayMetaTx';

    // Si llego adelantada, esperar afuera del lock a que se cierre el hueco (tomarlo aca
    // deadlockearia: la metatx que cierra el hueco necesita el mismo lock).
    await this.awaitTurn(from, BigInt(tx.nonce));

    // Reserva del nonce + envio: serializado por usuario, sin esperar el receipt adentro.
    const { sent, errorCode: simulatedCode, simulatedAddress, simulated, chain } = await this.withUserLock(
      from,
      () => this.submit({ from, tx, method, isDeploy, signingData, v, r, s, gasLimit, overrides }),
    );

    const settled = this.settle({
      sent,
      from,
      chain,
      tx,
      isDeploy,
      gasLimit,
      simulated,
      simulatedAddress,
      simulatedCode,
    });
    // El caller de submitRelay puede no esperar `settled` (el camino JSON-RPC no lo hace):
    // sin este catch, un fallo del receipt seria una unhandled rejection que tumba el proceso.
    settled.catch(() => undefined);

    return { transactionHash: sent.hash, from, to: tx.to, nonce: tx.nonce, isDeploy, settled };
  }

  /** Espera el receipt, libera la reserva del nonce y decodifica los eventos del hub. */
  private async settle(ctx: {
    sent: { hash: string; wait: () => Promise<TransactionReceipt | null> };
    from: string;
    chain: InflightChain;
    tx: Transaction;
    isDeploy: boolean;
    gasLimit: bigint;
    simulated: boolean;
    simulatedAddress: string | null;
    simulatedCode: number | null;
  }): Promise<RelayResult> {
    const { sent, from, chain, tx, isDeploy, gasLimit, simulated, simulatedAddress } = ctx;

    let errorCode: number | null = ctx.simulatedCode;
    let receipt: TransactionReceipt | null;
    try {
      // Con el lock liberado en el send, una tx que se cae del txpool dejaria colgados los
      // nonces posteriores del node. El timeout la convierte en un error visible en vez de un cuelgue.
      receipt = await waitWithTimeout(sent, this.cfg.receiptTimeoutMs);
    } catch (err) {
      // No sabemos si la metatx entro: cualquier nonce que hayamos reservado despues es basura.
      this.forgetInflight(from);
      throw err;
    } finally {
      this.releasePending(from, chain);
    }
    if (receipt == null) {
      this.forgetInflight(from);
      throw new RelayError(`No se obtuvo receipt para ${sent.hash}`, 'NO_RECEIPT');
    }

    const parsed = this.parseHubLogs(receipt);
    const relayed = parsed.find((log) => log.name === 'TransactionRelayed');
    const deployed = parsed.find((log) => log.name === 'ContractDeployed');
    const bad = parsed.find((log) => log.name === 'BadTransactionSent');

    if (bad) {
      errorCode = Number(bad.args.errorCode);
      // El hub rechazo la metatx, asi que NO incremento el nonce del usuario: todas las que
      // encadenamos despues quedaron invalidas. Olvidamos al usuario para que resincronice.
      // (Un revert del contrato destino no entra aca: eso es TransactionRelayed con
      // executed=false, y ahi el nonce si avanza y la cadena sigue sana.)
      this.forgetInflight(from);
      console.warn(
        `[relay] el hub rechazo ${receipt.hash} (${errorCodeName(errorCode)}) para ${from}: ` +
          'se descartan los nonces reservados, las metatx encadenadas posteriores van a fallar',
      );
    }

    return {
      transactionHash: receipt.hash,
      isDeploy,
      deployedAddress: deployed
        ? getAddress(deployed.args.contractDeployed as string)
        : simulatedAddress,
      blockNumber: receipt.blockNumber ?? null,
      gasUsed: receipt.gasUsed.toString(),
      errorCode,
      errorCodeName: errorCode === null ? null : errorCodeName(errorCode),
      simulated,
      executed: relayed
        ? Boolean(relayed.args.executed)
        : deployed
          ? true
          : bad
            ? false
            : null,
      from,
      to: tx.to,
      nonce: tx.nonce,
      metaTxGasLimit: gasLimit.toString(),
      output: relayed ? (relayed.args.output as string) : null,
      events: parsed.map((log) => log.name),
    };
  }

  /**
   * Seccion critica por usuario: reserva el nonce del hub, simula si corresponde y envia.
   * NO espera el receipt (eso serializaria al usuario a una metatx por bloque).
   */
  private async submit(ctx: {
    from: string;
    tx: Transaction;
    method: string;
    isDeploy: boolean;
    signingData: string;
    v: number;
    r: string;
    s: string;
    gasLimit: bigint;
    overrides: { gasLimit: bigint; gasPrice: bigint };
  }): Promise<{
    sent: { hash: string; wait: () => Promise<TransactionReceipt | null> };
    errorCode: number | null;
    simulatedAddress: string | null;
    simulated: boolean;
    chain: InflightChain;
  }> {
    const { from, tx, method, isDeploy, signingData, v, r, s, gasLimit, overrides } = ctx;
    const entry = this.inflight.get(from);

    if (entry && entry.pending >= this.cfg.maxInflightPerUser) {
      throw new RelayError(
        `${from} ya tiene ${entry.pending} metatx en vuelo (maximo ${this.cfg.maxInflightPerUser}). ` +
          'Esperar a que se minen antes de mandar mas.',
        'TOO_MANY_INFLIGHT',
        { pending: entry.pending, max: this.cfg.maxInflightPerUser },
      );
    }

    // Con metatx en vuelo el nonce de la cadena esta atrasado: manda lo que ya reservamos.
    const expectedNonce = entry ? entry.next : await this.getNonce(from);
    if (expectedNonce !== BigInt(tx.nonce)) {
      throw new RelayError(
        `Nonce invalido: el RelayHub espera ${expectedNonce} para ${from} y la metatx trae ${tx.nonce}`,
        'BAD_NONCE',
        { expected: Number(expectedNonce), got: tx.nonce, pending: entry?.pending ?? 0 },
      );
    }

    // La simulacion corre contra `latest`, donde el nonce del hub todavia es el viejo: si hay
    // metatx en vuelo devolveria BadNonce sin mirar nada mas. En ese caso no simulamos y se
    // pierde el pre-chequeo (cupo de gas del node, destino, firma) para las encadenadas.
    const canSimulate = this.cfg.simulateBeforeSend && entry === undefined;
    let errorCode: number | null = null;
    let simulatedAddress: string | null = null;
    if (canSimulate) {
      try {
        const result = await this.hub[method].staticCall(gasLimit, signingData, v, r, s, {
          ...overrides,
          from: this.nodeAddress,
        });
        // relayMetaTx devuelve uint8; deployMetaTx devuelve (uint8, address)
        errorCode = Number(isDeploy ? result[0] : result);
        if (isDeploy) simulatedAddress = getAddress(result[1] as string);
      } catch (err) {
        throw new RelayError(`La simulacion de ${method} fallo: ${(err as Error).message}`, 'SIMULATION_FAILED');
      }
      if (errorCode !== ERROR_CODE_OK) {
        throw new RelayError(
          `El RelayHub rechazaria la metatx: ${errorCodeName(errorCode)}`,
          `HUB_${errorCodeName(errorCode).toUpperCase()}`,
          { errorCode, errorCodeName: errorCodeName(errorCode) },
        );
      }
    }

    let sent;
    try {
      // Seccion critica global: asignar y consumir el nonce de la cuenta del writer node.
      sent = await this.withNonceLock(() => this.hub[method](gasLimit, signingData, v, r, s, overrides));
    } catch (err) {
      // El envio fallo, asi que este nonce no se consumio, pero los que ya estan en vuelo si.
      // Descartamos todo y que la proxima relea la cadena: reservar sobre un hueco no sirve.
      this.forgetInflight(from);
      const message = upstreamMessage(err);
      const hint = /not authorized|not permitted|permission/i.test(message)
        ? this.nodePermitted === false
          ? ` ${this.nodeAddress} no esta en AccountRules (${this.accountRules?.address}): darlo de alta con addAccount ahi, y con addNode en el hub.`
          : ` El nodo rechazo la transaccion del relayer: ${this.nodeAddress} tiene que ser un writer node permisionado (addNode en el hub + account permissioning).`
        : /insufficient funds/i.test(message)
          ? ' Revisar que la red use gasPrice 0 (en LAC-NET el writer node no necesita saldo).'
          : '';
      throw new RelayError(`No se pudo enviar ${method}: ${message}.${hint}`, 'SEND_FAILED');
    }

    let chain = entry;
    if (chain === undefined) {
      chain = { next: expectedNonce + 1n, pending: 1 };
      this.inflight.set(from, chain);
    } else {
      if (chain.expiry !== undefined) {
        clearTimeout(chain.expiry); // la rafaga sigue: cancelar el borrado diferido
        chain.expiry = undefined;
      }
      chain.next = expectedNonce + 1n;
      chain.pending += 1;
    }
    this.notifyTurn(from); // avanzo el nonce: le toca a la siguiente de la rafaga
    return { sent, errorCode, simulatedAddress, simulated: canSimulate, chain };
  }

  /**
   * Baja el contador de metatx en vuelo. Si la cadena ya se descarto (`chain` no es la vigente)
   * no toca nada: el contador de la cadena nueva no es asunto de un receipt de la vieja.
   * Al llegar a cero se olvida al usuario para que la proxima resincronice contra la cadena.
   */
  private releasePending(user: string, chain: InflightChain): void {
    if (this.inflight.get(user) !== chain) return;
    chain.pending -= 1;
    if (chain.pending > 0 || chain.expiry !== undefined) return;
    // Gracia antes de olvidar: el cliente puede tener metatx de la misma rafaga todavia en
    // camino, y necesitan que `nextNonce` siga contando lo que ya se reservo.
    chain.expiry = setTimeout(() => {
      if (this.inflight.get(user) === chain && chain.pending <= 0) this.inflight.delete(user);
    }, this.cfg.reorderWindowMs);
    chain.expiry.unref?.();
  }

  /**
   * Reescribe un receipt crudo del nodo para que un dapp vea el resultado de SU metatx y no el
   * de la tx del writer node. Sin esto el dapp ve `status: 1` (la tx al hub si funciono) aunque
   * su llamada haya revertido, y `contractAddress: null` en los deploys.
   *
   * Es lo mismo que hace el relay-signer en Go, mas el caso `BadTransactionSent`: cuando el hub
   * rechaza la metatx no la ejecuta, y devolver `status: 1` ahi seria mentirle al dapp.
   */
  enrichReceipt(receipt: RawReceipt): RawReceipt {
    if (receipt == null || !Array.isArray(receipt.logs)) return receipt;

    const out: RawReceipt = { ...receipt };
    for (const raw of receipt.logs as RawLog[]) {
      if (getAddress(raw.address) !== this.relayHubAddress) continue;
      const parsed = this.hub.interface.parseLog({ topics: [...raw.topics], data: raw.data });
      if (parsed === null) continue;

      if (parsed.name === 'ContractDeployed') {
        // El receipt del nodo trae contractAddress null: la tx fue una llamada al hub.
        out.contractAddress = getAddress(parsed.args.contractDeployed as string);
      } else if (parsed.name === 'TransactionRelayed' && !parsed.args.executed) {
        out.status = '0x0';
        out.revertReason = parsed.args.output as string;
      } else if (parsed.name === 'BadTransactionSent') {
        const code = Number(parsed.args.errorCode);
        out.status = '0x0';
        out.relayErrorCode = code;
        out.relayErrorCodeName = errorCodeName(code);
      }
    }
    return out;
  }

  private parseHubLogs(receipt: TransactionReceipt): LogDescription[] {
    const out: LogDescription[] = [];
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== this.relayHubAddress) continue;
      const parsed = this.hub.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed) out.push(parsed);
    }
    return out;
  }
}
