import 'dotenv/config';
import { getAddress } from 'ethers';
import { DEFAULT_EXPIRATION_TOLERANCE_SECONDS, DEFAULT_MIN_EXPIRATION_SECONDS } from './gas-model';

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === '') throw new Error(`Falta la variable de entorno ${name} (ver .env.example)`);
  return v.trim();
}

/**
 * Deriva el WS del nodo a partir del RPC HTTP: mismo host, puerto + 1. Es la convencion de Besu
 * (8545/8546, 4545/4546) y la que usa el relay-signer en Go. `WS_URL` la pisa.
 */
export function defaultWsUrl(rpcUrl: string): string {
  try {
    const url = new URL(rpcUrl);
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.port = String(port + 1);
    return url.toString().replace(/\/$/, '');
  } catch {
    return '';
  }
}

function optionalAddress(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? getAddress(v) : undefined;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),

  /**
   * RPC del nodo. IMPORTANTE: tiene que ser el JSON-RPC crudo de Besu.
   * El endpoint publico de un nodo lnet suele ser el relay-signer oficial, que intercepta
   * eth_sendRawTransaction esperando una metatx y rechazaria las tx de este relayer.
   */
  rpcUrl: required('RPC_URL'),

  /** Clave del writer node que paga/relaya (tiene que estar dada de alta con addNode en el hub). */
  nodePrivateKey: required('NODE_PRIVATE_KEY'),

  /** Si no se define, se resuelve preguntandole al proxy con getRelayHub(). */
  relayHubAddress: optionalAddress('RELAY_HUB_ADDRESS'),

  /**
   * Proxy del RelayHub (el mismo `trustedForwarder` que usan los contratos).
   * Default: lnet mainnet. En open-protestnet es 0xa4B5eE2906090ce2cDbf5dfff944db26f397037D.
   */
  relayHubProxyAddress:
    optionalAddress('RELAY_HUB_PROXY_ADDRESS') ?? getAddress('0xEAA5420AF59305c5ecacCB38fcDe70198001d147'),

  /** Simular con eth_call antes de mandar la tx para devolver el ErrorCode sin gastar un bloque. */
  simulateBeforeSend: (process.env.SIMULATE_BEFORE_SEND ?? 'true') !== 'false',

  /** Rechazar metatx cuyo nodeAddress embebido no sea el de este relayer. */
  enforceNodeAddress: (process.env.ENFORCE_NODE_ADDRESS ?? 'true') !== 'false',

  /** Rechazar metatx ya expiradas. */
  enforceExpiration: (process.env.ENFORCE_EXPIRATION ?? 'true') !== 'false',

  /**
   * Ventana minima que le tiene que quedar a la metatx cuando llega. Una expiration al filo no
   * sirve: entre la validacion, la simulacion, la espera del nonce y el minado pasan segundos, y
   * si vence en el medio el nodo la descarta despues de haber gastado una tx del writer node.
   * Solo aplica con ENFORCE_EXPIRATION=true.
   */
  minExpirationSeconds: Number(process.env.MIN_EXPIRATION_SECONDS ?? DEFAULT_MIN_EXPIRATION_SECONDS),

  /**
   * Tolerancia con la que se aplica ese minimo. Quien firma `ahora + 300` llega con 299 o 298 (la
   * latencia del POST y el floor a segundos de cada lado), asi que exigir el valor exacto
   * rechazaria justo al cliente que firmo lo que se le pidio. Subirla si la red es mas lenta.
   */
  expirationToleranceSeconds: Number(
    process.env.EXPIRATION_LATENCY_TOLERANCE_SECONDS ?? DEFAULT_EXPIRATION_TOLERANCE_SECONDS,
  ),

  /**
   * Exigir que el USUARIO de la metatx este dado de alta en AccountRules, como hace el
   * relay-signer en Go. Apagado por defecto: en el modelo de gas de LAC-NET los usuarios no
   * tienen por que estar permisionados (el permissioning del nodo mira al writer node), asi que
   * prenderlo convierte a AccountRules en el allowlist de este relayer.
   */
  enforceAccountRules: (process.env.ENFORCE_ACCOUNT_RULES ?? 'false') === 'true',

  /** AccountRules directo. Vacio => se resuelve con AccountIngress.getContractAddress("rules"). */
  accountRulesAddress: optionalAddress('ACCOUNT_RULES_ADDRESS'),

  /**
   * AccountIngress, el registry del permissioning de Besu. Default: la direccion que usa LACChain
   * (verificada en open-protestnet y en lnet mainnet). Definida vacia desactiva la resolucion.
   */
  accountIngressAddress:
    process.env.ACCOUNT_INGRESS_ADDRESS === undefined
      ? getAddress('0x0000000000000000000000000000000000008888')
      : optionalAddress('ACCOUNT_INGRESS_ADDRESS'),

  /**
   * Cuanto se cachea el resultado de `accountPermitted`. Sin cache seria un eth_call extra por
   * metatx; con cache, dar de alta una cuenta tarda hasta esto en verse.
   */
  accountRulesCacheMs: Number(process.env.ACCOUNT_RULES_CACHE_MS ?? 30_000),

  /** Techo de espera del receipt. Vencido, se responde RECEIPT_TIMEOUT en vez de colgarse. */
  receiptTimeoutMs: Number(process.env.RECEIPT_TIMEOUT_MS ?? 60_000),

  /**
   * Metatx en vuelo (enviadas y sin receipt) que se le permiten a un mismo usuario.
   * Acota el dano si la cadena de nonces se rompe: todas las posteriores a la que falla
   * las rechaza el hub on-chain, y cada una gasta una tx del writer node.
   */
  maxInflightPerUser: Number(process.env.MAX_INFLIGHT_PER_USER ?? 16),

  /**
   * Cuanto espera una metatx que llego adelantada a que se cierre el hueco de nonces.
   * Sobre HTTP el orden de llegada no esta garantizado, y el hub exige el nonce exacto.
   */
  reorderWindowMs: Number(process.env.REORDER_WINDOW_MS ?? 3_000),

  /**
   * Origen permitido por CORS, para que un dapp de browser pueda apuntar su provider aca.
   * Vacio desactiva las cabeceras (util si hay un gateway adelante que ya las pone).
   */
  corsOrigin: process.env.CORS_ORIGIN ?? '*',

  /**
   * WS del nodo, para eth_subscribe. Vacio => se deriva del RPC (mismo host, puerto + 1), que es
   * la convencion de Besu (8545/8546, 4545/4546). Si el nodo no expone WS, eth_subscribe devuelve
   * un error explicito y el resto del proxy sigue andando igual.
   */
  wsUrl: process.env.WS_URL?.trim() ?? '',

  /**
   * Techo para abrir el WS del nodo. Sin esto se cae en el timeout de TCP del SO (~75 s) y el
   * dapp queda colgado esperando la respuesta de su eth_subscribe.
   */
  wsConnectTimeoutMs: Number(process.env.WS_CONNECT_TIMEOUT_MS ?? 10_000),
};

// El default se resuelve aca y no adentro del objeto para poder leer `config.rpcUrl` ya normalizado.
if (config.wsUrl === '') config.wsUrl = defaultWsUrl(config.rpcUrl);

export type Config = typeof config;
