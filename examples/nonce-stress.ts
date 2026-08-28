/**
 * Prueba de carga del manejo de nonces: manda muchas metatx simultaneas y verifica que el relayer
 * las encadene sin huecos, sin repetidos y sin perder ninguna.
 *
 *   npx tsx examples/nonce-stress.ts                          # 12 metatx de un usuario
 *   npx tsx examples/nonce-stress.ts --n 20 --users 3         # 20 por usuario, 3 usuarios a la vez
 *   npx tsx examples/nonce-stress.ts --overflow               # pasarse de MAX_INFLIGHT_PER_USER
 *   npx tsx examples/nonce-stress.ts --url http://host:3000 --to 0xContrato
 *   npx tsx examples/nonce-stress.ts --quiet                  # solo el resumen y las verificaciones
 *   npx tsx examples/nonce-stress.ts --rest                   # por POST /relay en vez del proxy
 *
 * La rafaga va por el **proxy JSON-RPC** (POST /), que es por donde entra un dapp real:
 * `eth_getTransactionCount` para el nonce, `eth_sendRawTransaction` para mandar y poleo de
 * `eth_getTransactionReceipt` para el resultado. Asi lo que se estresa es el camino que se usa
 * en serio, con las tres intercepciones del proxy adentro de la rafaga. `--rest` vuelve al
 * camino corto (`POST /relay`, que responde recien con el receipt) para comparar.
 *
 * Lo unico que sigue yendo por REST es el `GET /info` inicial: no hay metodo JSON-RPC que
 * exponga la config del relayer, y es descubrimiento previo, no parte de la carga.
 *
 * Por defecto va en modo verboso: cada metatx deja rastro en consola (firma, reintentos, receipt,
 * latencia) con el reloj de la corrida, para poder mirar la rafaga mientras pasa y no solo el
 * resumen. `--quiet` deja la salida compacta de siempre.
 *
 * Que se esta estresando:
 *
 *   - **Nonce del RelayHub** (el que va firmado en la metatx). Es `nonces[writerNode][usuario]` y
 *     solo sube cuando la metatx se mina, asi que para encadenar el relayer lleva en memoria lo que
 *     ya reservo. Si esa contabilidad estuviera mal, una rafaga daria BAD_NONCE o huecos.
 *   - **Nonce de la cuenta del writer node** (el de la tx externa). Lo asigna ethers dentro del
 *     send, serializado por un lock global; si dos envios lo leyeran en paralelo, una tx
 *     reemplazaria a la otra en el txpool y la reemplazada nunca se minaria (RECEIPT_TIMEOUT).
 *   - **Cursor local del cliente**: N `send()` concurrentes sin cursor firmarian todos el mismo
 *     nonce. `MetaTxClient` los reparte y reintenta ante BAD_NONCE.
 *   - **El proxy JSON-RPC**: que `eth_getTransactionCount` con 'pending' devuelva el nonce del
 *     hub contando lo en vuelo (con el de la cuenta la rafaga entera firmaria el mismo nonce), y
 *     que el receipt reescrito diga si la llamada del usuario se ejecuto.
 *
 * Los usuarios extra (`--users N`) son wallets random: en el modelo de gas no necesitan fondos ni
 * permissioning, solo firman. Con ENFORCE_ACCOUNT_RULES=true en el relayer no van a pasar, y el
 * script lo avisa antes de intentarlo.
 *
 * SUPUESTO: el relayer apuntado tiene que ser el unico proceso usando esa clave de writer node. Dos
 * instancias compartiendola se pisan en el nonce de la cuenta y esta prueba lo va a marcar como
 * RECEIPT_TIMEOUT (que es justamente el sintoma).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import 'dotenv/config';
import { Wallet } from 'ethers';
import { MetaTxClient, RelayResponse } from '../src/metatx';

interface Info {
  nodeAddress: string;
  minExpirationSeconds?: number;
  maxInflightPerUser?: number;
  enforceAccountRules?: boolean;
  accountRulesAddress?: string | null;
}

interface Attempt {
  user: string;
  index: number;
  /** Etiqueta corta para la traza: `u0#03`. */
  tag: string;
  ok: boolean;
  /** Cuanto tardo el `send()` completo, reintentos incluidos. */
  ms: number;
  /** Cuantas veces hubo que refirmar (reintentos por BAD_NONCE). */
  retries: number;
  relayed?: RelayResponse;
  code?: string;
  message?: string;
}

function parseArgs(argv: string[]) {
  const out = {
    n: 12,
    users: 1,
    to: process.env.TARGET_ADDRESS,
    url: process.env.RELAYER_URL ?? 'http://localhost:3000',
    overflow: false,
    verbose: true,
    transport: 'rpc' as 'rest' | 'rpc',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--n') out.n = Number(argv[++i]);
    else if (a === '--users') out.users = Number(argv[++i]);
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--overflow') out.overflow = true;
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--quiet' || a === '-q') out.verbose = false;
    else if (a === '--rest') out.transport = 'rest';
    else if (a === '--rpc') out.transport = 'rpc';
    else throw new Error(`Argumento desconocido: ${a}`);
  }
  return out;
}

const ok = (msg: string) => console.log(`  ok      ${msg}`);
const fail = (msg: string) => {
  console.error(`  FALLA   ${msg}`);
  process.exitCode = 1;
};
const info = (msg: string) => console.log(`  info    ${msg}`);

// ---------------------------------------------------------------------------
// Traza
// ---------------------------------------------------------------------------

let VERBOSE = true;
/** Arranca cuando se lanza la rafaga: todas las lineas de traza son relativas a ese instante. */
let CLOCK = Date.now();

const stamp = () => `[${((Date.now() - CLOCK) / 1000).toFixed(3).padStart(7)}s]`;
const shortHash = (h?: string | null) => (h ? `${h.slice(0, 10)}..${h.slice(-6)}` : '-');

/**
 * Por el proxy JSON-RPC el resultado sale del receipt, que no dice si el relayer pre-simulo la
 * metatx. Solo se muestra cuando el dato existe (transporte REST).
 */
const simulationNote = (r: RelayResponse) =>
  r.simulated === undefined ? '' : `${r.simulated ? 'simulada' : 'encadenada'}  `;

/** Una linea de traza: reloj, quien, que paso, detalle. Muda con `--quiet`. */
function trace(tag: string, event: string, detail = ''): void {
  if (VERBOSE) console.log(`${stamp()} ${tag.padEnd(7)} ${event.padEnd(10)} ${detail}`);
}

/**
 * Contexto por metatx. El cliente reintenta y estima gas por dentro, asi que la unica forma de
 * atribuir cada firma a la metatx que la origino sin tocar `MetaTxClient` es un AsyncLocalStorage:
 * el store viaja solo por los `await` de ese `send()`.
 */
interface Ctx {
  tag: string;
  /** Cuantas firmas lleva: 0 = la original, >0 = reintentos por BAD_NONCE. */
  attempt: number;
}
const ctx = new AsyncLocalStorage<Ctx>();

/** `MetaTxClient` con traza: loguea cada firma (incluidas las refirmas) y el cierre del envio. */
class TracingClient extends MetaTxClient {
  async sign(params: { to: string | null; data: string; gasLimit?: bigint; nonce?: number }) {
    const c = ctx.getStore();
    const signed = await super.sign(params);
    if (c) {
      const evento = c.attempt === 0 ? 'firma' : `refirma${c.attempt}`;
      const nota = c.attempt === 0 ? '' : '  (el cliente solo refirma ante BAD_NONCE)';
      trace(c.tag, evento, `nonce hub ${signed.nonce}  gasLimit ${signed.gasLimit}  metaTxGasLimit ${signed.metaTxGasLimit}${nota}`);
      c.attempt += 1;
    }
    return signed;
  }

  async send(params: { to: string | null; data: string; gasLimit?: bigint; nonce?: number }): Promise<RelayResponse> {
    const c = ctx.getStore();
    // Ojo con el orden: esta linea sale antes que la de `firma` porque el nonce y el gas se
    // resuelven dentro del `send()`, no antes de llamarlo.
    if (c) trace(c.tag, 'arranca', `destino ${params.to ?? '(deploy)'}`);
    return super.send(params);
  }
}

// ---------------------------------------------------------------------------
// Rafaga
// ---------------------------------------------------------------------------

/** Manda `n` metatx concurrentes de un usuario y devuelve el resultado de cada intento. */
async function burst(client: TracingClient, user: number, to: string, n: number, base: number): Promise<Attempt[]> {
  return Promise.all(
    Array.from({ length: n }, (_, index) => {
      const tag = `u${user}#${String(index).padStart(2, '0')}`;
      const store: Ctx = { tag, attempt: 0 };
      const t = Date.now();
      return ctx
        .run(store, () => client.call(to, 'store(uint256)', [base + index]))
        .then(
          (relayed): Attempt => {
            const ms = Date.now() - t;
            trace(
              tag,
              'OK',
              `nonce hub ${relayed.nonce}  bloque ${relayed.blockNumber}  gas ${relayed.gasUsed}  ` +
                `${relayed.executed ? 'ejecutada' : 'REVERTIDA'}  ${simulationNote(relayed)}` +
                `tx ${shortHash(relayed.transactionHash)}  ${ms} ms`,
            );
            return { user: client.address, index, tag, ok: true, ms, retries: store.attempt - 1, relayed };
          },
          (err: Error): Attempt => {
            const ms = Date.now() - t;
            // El cliente serializa el error como "... [CODE]: mensaje"
            const code = /\[([A-Z_]+)\]/.exec(err.message)?.[1] ?? 'DESCONOCIDO';
            trace(tag, 'RECHAZO', `${code}  ${ms} ms  ${err.message}`);
            return { user: client.address, index, tag, ok: false, ms, retries: store.attempt - 1, code, message: err.message };
          },
        );
    }),
  );
}

// ---------------------------------------------------------------------------
// Verificaciones
// ---------------------------------------------------------------------------

/** Verifica la cadena de nonces de un usuario: consecutivos desde `start`, sin repetidos. */
function checkUserNonces(label: string, attempts: Attempt[], start: number, minedAfter: number): void {
  const nonces = attempts.filter((a) => a.ok).map((a) => a.relayed!.nonce).sort((a, b) => a - b);
  const unique = new Set(nonces);

  if (VERBOSE) info(`${label}: nonces devueltos = [${nonces.join(', ')}]  (hub antes ${start}, hub despues ${minedAfter})`);

  if (nonces.length === 0) {
    fail(`${label}: ninguna metatx entro`);
    return;
  }
  if (unique.size !== nonces.length) {
    fail(`${label}: nonces repetidos (${nonces.join(', ')})`);
  } else if (nonces[0] !== start) {
    fail(`${label}: la cadena arranca en ${nonces[0]} y el nonce del hub era ${start}`);
  } else {
    const gaps = nonces.filter((v, i) => v !== start + i);
    if (gaps.length > 0) fail(`${label}: huecos en la cadena (${nonces.join(', ')})`);
    else ok(`${label}: ${nonces.length} nonces consecutivos ${start}..${start + nonces.length - 1}`);
  }

  const expected = start + nonces.length;
  minedAfter === expected
    ? ok(`${label}: el nonce del hub quedo en ${minedAfter} (= ${start} + ${nonces.length} minadas)`)
    : fail(`${label}: el nonce del hub quedo en ${minedAfter} y se esperaba ${expected}`);
}

/** Tabla por usuario con el detalle de cada metatx, en orden de envio. */
function printDetail(label: string, address: string, attempts: Attempt[]): void {
  console.log(`\ndetalle ${label} (${address}):`);
  for (const a of [...attempts].sort((x, y) => x.index - y.index)) {
    const reintentos = a.retries > 0 ? `  reintentos ${a.retries}` : '';
    if (a.ok) {
      const r = a.relayed!;
      console.log(
        `  ${a.tag}  nonce ${String(r.nonce).padStart(4)}  bloque ${r.blockNumber}  gas ${String(r.gasUsed).padStart(7)}  ` +
          `${String(a.ms).padStart(5)} ms  ${r.executed ? 'ejecutada' : 'REVERTIDA'}  ` +
          `${simulationNote(r)}tx ${shortHash(r.transactionHash)}${reintentos}` +
          (r.events?.length ? `  eventos: ${r.events.join(',')}` : ''),
      );
    } else {
      console.log(`  ${a.tag}  RECHAZADA  ${a.code}  ${String(a.ms).padStart(5)} ms${reintentos}  ${a.message}`);
    }
  }
}

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  VERBOSE = args.verbose;
  if (!args.to) throw new Error('Falta el contrato destino: --to 0x... o TARGET_ADDRESS en el .env');
  if (!process.env.USER_PRIVATE_KEY) throw new Error('Falta USER_PRIVATE_KEY en el .env');

  const res = await fetch(new URL('/info', args.url));
  if (!res.ok) throw new Error(`GET /info devolvio ${res.status}: no hay relayer en ${args.url}`);
  const relayer = (await res.json()) as Info & Record<string, unknown>;
  const maxInflight = relayer.maxInflightPerUser ?? 16;

  const n = args.overflow ? maxInflight + 4 : args.n;
  console.log(`relayer          : ${args.url}`);
  console.log(`writer node      : ${relayer.nodeAddress}`);
  console.log(`contrato destino : ${args.to}`);
  console.log(`MAX_INFLIGHT     : ${maxInflight} por usuario`);
  console.log(`rafaga           : ${n} metatx simultaneas x ${args.users} usuario(s)` + (args.overflow ? '  (modo overflow)' : ''));
  console.log(
    `transporte       : ${args.transport === 'rpc' ? 'proxy JSON-RPC (POST /, como un dapp)' : 'REST (POST /relay)'}`,
  );
  console.log(`modo             : ${VERBOSE ? 'verboso (--quiet para el resumen solo)' : 'compacto'}`);

  if (VERBOSE) {
    console.log('\n/info completo del relayer:');
    for (const [k, v] of Object.entries(relayer)) console.log(`  ${k.padEnd(24)} ${JSON.stringify(v)}`);
  }

  if (args.users > 1 && relayer.enforceAccountRules) {
    throw new Error(
      `El relayer corre con ENFORCE_ACCOUNT_RULES=true (AccountRules ${relayer.accountRulesAddress}): ` +
        'los usuarios random de --users no estan permisionados y serian rechazados. Correr con --users 1.',
    );
  }

  // Usuario 0 = el del .env (ya tiene historia en el hub); el resto, wallets random.
  const opts = { transport: args.transport };
  const clients = [
    new TracingClient(process.env.USER_PRIVATE_KEY, args.url, opts),
    ...Array.from({ length: args.users - 1 }, () => new TracingClient(Wallet.createRandom().privateKey, args.url, opts)),
  ];

  const before = await Promise.all(clients.map((c) => c.minedNonce()));
  console.log('');
  clients.forEach((c, i) => console.log(`usuario ${i}        : ${c.address} (nonce del hub ${before[i]})`));

  console.log(`\nenviando ${n * clients.length} metatx...`);
  CLOCK = Date.now();
  const attempts = (await Promise.all(clients.map((c, i) => burst(c, i, args.to!, n, 10_000 * (i + 1))))).flat();
  const ms = Date.now() - CLOCK;

  const okAttempts = attempts.filter((a) => a.ok);
  const byBlock = new Map<number, number>();
  for (const a of okAttempts) byBlock.set(a.relayed!.blockNumber!, (byBlock.get(a.relayed!.blockNumber!) ?? 0) + 1);
  const failuresByCode = new Map<string, number>();
  for (const a of attempts.filter((x) => !x.ok)) failuresByCode.set(a.code!, (failuresByCode.get(a.code!) ?? 0) + 1);

  console.log(`\n${okAttempts.length}/${attempts.length} aceptadas en ${ms} ms (${(okAttempts.length / (ms / 1000)).toFixed(1)} metatx/s)`);
  console.log('metatx por bloque:', [...byBlock.entries()].sort((a, b) => a[0] - b[0]).map(([b, c]) => `${b}: ${c}`).join(' | '));
  if (failuresByCode.size > 0) {
    console.log('rechazos:', [...failuresByCode.entries()].map(([c, q]) => `${c} x${q}`).join(' | '));
  }

  if (VERBOSE) {
    const lat = attempts.map((a) => a.ms).sort((a, b) => a - b);
    const gas = okAttempts.reduce((acc, a) => acc + BigInt(a.relayed!.gasUsed), 0n);
    const retries = attempts.reduce((acc, a) => acc + a.retries, 0);
    console.log(
      `latencia por metatx: min ${lat[0]} ms | p50 ${percentile(lat, 0.5)} ms | p90 ${percentile(lat, 0.9)} ms | max ${lat[lat.length - 1]} ms`,
    );
    console.log(`gas total de las aceptadas: ${gas} | refirmas por BAD_NONCE: ${retries} | bloques tocados: ${byBlock.size}`);
    clients.forEach((c, i) => printDetail(`usuario ${i}`, c.address, attempts.filter((a) => a.user === c.address)));
  }

  console.log('\nverificaciones:');
  const after = await Promise.all(clients.map((c) => c.minedNonce()));
  clients.forEach((c, i) => {
    checkUserNonces(`usuario ${i}`, attempts.filter((a) => a.user === c.address), before[i], after[i]);
  });

  // Con la simulacion prendida solo la primera de cada cadena se simula: las encadenadas corren
  // contra `latest`, donde el nonce del hub todavia es el viejo, y darian BadNonce.
  if (okAttempts.some((a) => a.relayed!.simulated !== undefined)) {
    const simulated = okAttempts.filter((a) => a.relayed!.simulated).length;
    simulated <= clients.length
      ? ok(`${simulated} metatx simuladas (una por cadena como maximo, el resto van encadenadas)`)
      : info(`${simulated} metatx simuladas: hubo cadenas que se vaciaron durante la rafaga`);
  } else {
    info('por el proxy JSON-RPC no se ve si el relayer simulo: el receipt no lo dice (con --rest si)');
  }

  const executed = okAttempts.filter((a) => a.relayed!.executed).length;
  executed === okAttempts.length
    ? ok(`las ${executed} aceptadas se ejecutaron en el contrato destino`)
    : fail(`${okAttempts.length - executed} aceptadas no ejecutaron la llamada del usuario`);

  const pendings = await Promise.all(clients.map((c) => c.pendingCount()));
  pendings.every((p) => p === 0)
    ? ok('no quedaron metatx en vuelo (pending = 0 para todos los usuarios)')
    : fail(`quedaron metatx en vuelo: pending = ${pendings.join(', ')}`);

  if (args.overflow) {
    // Pasarse del techo se manifiesta de dos formas, segun donde pegue la rafaga: TOO_MANY_INFLIGHT
    // si la cadena ya tiene `maxInflight` sin receipt, o BAD_NONCE si lo que se lleno es la cola de
    // espera de `awaitTurn` (que tiene el mismo techo) y la metatx entra a validar adelantada.
    const rejected = attempts.length - okAttempts.length;
    const codes = [...failuresByCode.entries()].map(([c, q]) => `${c} x${q}`).join(', ');
    rejected === 0
      ? info(`modo overflow: no se rechazo ninguna (se minaron mas rapido de lo que entraba la rafaga)`)
      : ok(
          `modo overflow: ${rejected} rechazos (${codes}) al pasarse de ${maxInflight}, ` +
            'y la cadena quedo consistente igual: se pierden metatx, no se corrompe el nonce',
        );
  } else if (failuresByCode.size > 0) {
    fail(`hubo ${attempts.length - okAttempts.length} rechazos en una rafaga que deberia entrar entera`);
  }

  const value = (await clients[0].read(args.to, 'retrieve() view returns (uint256)'))[0] as bigint;
  info(`retrieve() = ${value} (gana la ultima minada, cualquiera de las ${okAttempts.length} es valida)`);

  console.log(process.exitCode ? '\nprueba con fallas' : '\nprueba OK: el manejo de nonces aguanto la rafaga');
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
