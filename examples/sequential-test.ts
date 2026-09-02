/**
 * Prueba secuencial del manejo de nonces: manda las metatx **de a una** y con el nonce elegido
 * por el cliente, que se hace cargo de mandarlas en orden.
 *
 *   npx tsx examples/sequential-test.ts                       # 6 metatx, una atras de la otra
 *   npx tsx examples/sequential-test.ts --n 12
 *   npx tsx examples/sequential-test.ts --ask                 # pidiendole el nonce al relayer
 *   npx tsx examples/sequential-test.ts --gap                 # saltearse un nonce a proposito
 *   npx tsx examples/sequential-test.ts --url http://host:3001 --to 0xContrato
 *   npx tsx examples/sequential-test.ts --rest                # por POST /relay en vez del proxy
 *   npx tsx examples/sequential-test.ts --quiet               # solo el resumen y las verificaciones
 *
 * Es la contracara de `nonce-stress.ts`. Aquella manda una rafaga concurrente y le pide al
 * relayer que la encadene; esta manda una sola metatx a la vez, espera su receipt, y recien ahi
 * manda la siguiente. El nonce va **fijado por el cliente** (`send({ nonce })`), que lo lleva en
 * un contador propio arrancando en el nonce del hub. Ese camino es distinto en un punto que
 * importa: con el nonce fijado a mano `MetaTxClient` NO reintenta ante BAD_NONCE --lo elegiste
 * vos, refirmarlo con otro numero seria peor que el error--, asi que cualquier desalineacion se
 * ve como una falla en vez de taparse con una refirma.
 *
 * Que se esta verificando, que la rafaga no puede mostrar:
 *
 *   - **El contrato del nonce, sin red de contencion.** Un cliente ordenado que cuenta 1, 2, 3
 *     desde el nonce del hub tiene que entrar siempre, sin refirmas y sin reordenamiento: cada
 *     metatx llega cuando la anterior ya se mino.
 *   - **El orden se ve en la cadena.** Como se espera el receipt de cada una, despues de cada
 *     metatx `retrieve()` tiene que devolver exactamente el valor recien escrito. En la rafaga
 *     concurrente eso no se puede afirmar: gana la ultima minada, cualquiera es valida.
 *   - **El nonce del hub avanza de a uno.** Se lee despues de cada metatx y tiene que subir
 *     exactamente 1: ni se saltea (una metatx de mas) ni se queda (una que se dio por aceptada
 *     sin minarse).
 *   - **Con `--gap`, que pasa si el cliente se equivoca.** Se saltea un nonce a proposito: el
 *     relayer retiene la adelantada hasta que se vence `REORDER_WINDOW_MS` y despues la rechaza
 *     con BAD_NONCE, sin mover el nonce del hub y sin romper la cadena para la siguiente.
 *
 * `--ask` cambia de donde sale el nonce: en vez del contador local, se le pregunta al relayer
 * antes de cada metatx (`eth_getTransactionCount` con 'pending', o `GET /nonce/:address` con
 * `--rest`). Secuencial los dos tienen que dar lo mismo, y el script lo compara. Ojo que ahi el
 * numero lo elige el relayer, asi que `--ask` prueba el endpoint del nonce, no al cliente
 * ordenado.
 *
 * Sale con codigo 0 si todo paso y 1 si alguna verificacion fallo, asi que sirve tal cual en CI.
 *
 * SUPUESTO: nadie mas esta mandando metatx de ese usuario mientras corre. Un segundo cliente
 * consumiendo nonces del mismo address rompe la premisa de la prueba (el contador local queda
 * viejo) y se ve como BAD_NONCE.
 */
import 'dotenv/config';
import { Interface } from 'ethers';
import { MetaTxClient, RelayResponse } from '../src/metatx';

interface Info {
  nodeAddress: string;
  maxInflightPerUser?: number;
  reorderWindowMs?: number;
  autoNonce?: boolean;
}

interface Step {
  /** Etiqueta corta para la traza: `#03`. */
  tag: string;
  index: number;
  /** Nonce del hub con el que se firmo. */
  nonce: number;
  /** Valor mandado a `store(uint256)`. */
  value: number;
  ok: boolean;
  /** Cuanto tardo el `send()` completo (incluye el poleo del receipt por el proxy). */
  ms: number;
  relayed?: RelayResponse;
  code?: string;
  message?: string;
}

function parseArgs(argv: string[]) {
  const out = {
    n: 6,
    to: process.env.TARGET_ADDRESS,
    url: process.env.RELAYER_URL ?? 'http://localhost:3001',
    ask: false,
    gap: false,
    verbose: true,
    transport: 'rpc' as 'rest' | 'rpc',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--n') out.n = Number(argv[++i]);
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--url') out.url = argv[++i];
    else if (a === '--ask') out.ask = true;
    else if (a === '--gap') out.gap = true;
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
/** Arranca cuando se manda la primera metatx: la traza es relativa a ese instante. */
let CLOCK = Date.now();

const stamp = () => `[${((Date.now() - CLOCK) / 1000).toFixed(3).padStart(7)}s]`;
const shortHash = (h?: string | null) => (h ? `${h.slice(0, 10)}..${h.slice(-6)}` : '-');

/** Solo con `--rest`: por el proxy el receipt no dice si el relayer pre-simulo la metatx. */
const simulationNote = (r: RelayResponse) =>
  r.simulated === undefined ? '' : `${r.simulated ? 'simulada' : 'encadenada'}  `;

function trace(tag: string, event: string, detail = ''): void {
  if (VERBOSE) console.log(`${stamp()} ${tag.padEnd(5)} ${event.padEnd(10)} ${detail}`);
}

/**
 * `MetaTxClient` con traza de la firma. Al ser secuencial alcanza con una variable de modulo para
 * saber a que metatx pertenece cada firma: nunca hay dos `send()` solapados (en `nonce-stress.ts`,
 * que si los solapa, hace falta un AsyncLocalStorage).
 */
let currentTag = '';
let signCount = 0;

class TracingClient extends MetaTxClient {
  async sign(params: { to: string | null; data: string; gasLimit?: bigint; nonce?: number }) {
    const signed = await super.sign(params);
    signCount += 1;
    trace(currentTag, 'firma', `nonce hub ${signed.nonce}  gasLimit ${signed.gasLimit}  metaTxGasLimit ${signed.metaTxGasLimit}`);
    return signed;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const storeIface = new Interface(['function store(uint256)']);
const storeData = (value: number) => storeIface.encodeFunctionData('store', [value]);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Espera a que el nonce minado del hub llegue a `expected`. El receipt ya esta, asi que el bloque
 * se mino: el poleo es solo por el nodo que contesta el `eth_call` un instante atras de si mismo.
 * Devuelve el ultimo valor leido (== expected si llego).
 */
async function waitForHubNonce(client: MetaTxClient, expected: number, timeoutMs = 3_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const mined = await client.minedNonce();
    if (mined >= expected || Date.now() >= deadline) return mined;
    await sleep(200);
  }
}

/** El cliente serializa el error del relayer como "... [CODIGO]: mensaje". */
const errorCode = (err: Error) => /\[([A-Z_]+)\]/.exec(err.message)?.[1] ?? 'DESCONOCIDO';

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];

// ---------------------------------------------------------------------------
// La corrida secuencial
// ---------------------------------------------------------------------------

/**
 * Manda `n` metatx de a una, esperando el receipt de cada una antes de firmar la siguiente, y
 * verifica sobre la marcha que el nonce del hub avance de a uno y que el valor quede escrito.
 *
 * Corta al primer rechazo: en secuencial una metatx que no entro deja el contador local adelantado
 * y todas las que siguen serian BAD_NONCE por arrastre, sin agregar informacion.
 */
async function runSequence(
  client: TracingClient,
  args: { to: string; n: number; ask: boolean },
  start: number,
  base: number,
): Promise<Step[]> {
  const steps: Step[] = [];
  let nonce = start;

  for (let index = 0; index < args.n; index++) {
    const tag = `#${String(index).padStart(2, '0')}`;
    currentTag = tag;
    const value = base + index;

    if (args.ask) {
      // Con --ask el numero lo pone el relayer. Secuencial tiene que coincidir con el contador.
      const handed = await client.nonce();
      if (handed !== nonce) {
        fail(`${tag}: el relayer entrego el nonce ${handed} y el contador local iba en ${nonce}`);
        nonce = handed; // seguir con el del relayer: es el unico que el hub va a aceptar
      }
    }

    trace(tag, 'arranca', `nonce hub ${nonce}  store(${value})`);
    const t = Date.now();
    let relayed: RelayResponse;
    try {
      relayed = await client.send({ to: args.to, data: storeData(value), nonce });
    } catch (err) {
      const ms = Date.now() - t;
      const code = errorCode(err as Error);
      trace(tag, 'RECHAZO', `${code}  ${ms} ms  ${(err as Error).message}`);
      steps.push({ tag, index, nonce, value, ok: false, ms, code, message: (err as Error).message });
      fail(`${tag}: la metatx con nonce ${nonce} fue rechazada (${code}); se corta la secuencia`);
      break;
    }
    const ms = Date.now() - t;
    trace(
      tag,
      'OK',
      `nonce hub ${relayed.nonce}  bloque ${relayed.blockNumber}  gas ${relayed.gasUsed}  ` +
        `${relayed.executed ? 'ejecutada' : 'REVERTIDA'}  ${simulationNote(relayed)}` +
        `tx ${shortHash(relayed.transactionHash)}  ${ms} ms`,
    );
    steps.push({ tag, index, nonce, value, ok: true, ms, relayed });

    if (relayed.nonce !== nonce) fail(`${tag}: se firmo el nonce ${nonce} y el relayer contesto ${relayed.nonce}`);

    // El nonce del hub tiene que subir exactamente uno por metatx minada.
    const mined = await waitForHubNonce(client, nonce + 1);
    mined === nonce + 1
      ? trace(tag, 'hub', `nonce minado ${nonce} -> ${mined}`)
      : fail(`${tag}: el nonce del hub quedo en ${mined} y se esperaba ${nonce + 1}`);

    // Y el valor tiene que estar escrito: esto es lo que la rafaga concurrente no puede afirmar.
    const stored = Number((await client.read(args.to, 'retrieve() view returns (uint256)'))[0]);
    stored === value
      ? trace(tag, 'retrieve', `${stored}`)
      : fail(`${tag}: retrieve() devolvio ${stored} y se acababa de escribir ${value}`);

    nonce += 1;
  }

  return steps;
}

// ---------------------------------------------------------------------------
// Fase --gap: el cliente se saltea un nonce
// ---------------------------------------------------------------------------

/**
 * Manda una metatx con el nonce adelantado en uno y despues la que iba en orden. Lo esperado:
 *
 *   1. la adelantada queda retenida en el buffer de reordenamiento (por si la que falta venia
 *      atrasada en la red) y, al vencer `REORDER_WINDOW_MS` sin que aparezca, se rechaza con
 *      BAD_NONCE indicando el nonce que el hub espera;
 *   2. el nonce del hub no se movio;
 *   3. la siguiente en orden entra normal: un cliente desordenado pierde SU metatx, no rompe la
 *      cadena del usuario.
 */
async function runGap(client: TracingClient, to: string, free: number, value: number, reorderWindowMs: number): Promise<void> {
  console.log(`\nfase --gap: se saltea el nonce ${free} y se manda el ${free + 1} (ventana de reordenamiento ${reorderWindowMs} ms)`);
  currentTag = 'gap';

  const before = await client.minedNonce();
  trace('gap', 'arranca', `nonce hub ${free + 1} (adelantado)  store(${value})`);
  const t = Date.now();
  try {
    await client.send({ to, data: storeData(value), nonce: free + 1 });
    fail(`la metatx adelantada (nonce ${free + 1}) entro con el hub esperando ${free}`);
  } catch (err) {
    const code = errorCode(err as Error);
    const heldMs = Date.now() - t;
    code === 'BAD_NONCE'
      ? ok(`la metatx adelantada se rechazo con BAD_NONCE tras ${heldMs} ms retenida (${(err as Error).message})`)
      : fail(`la metatx adelantada se rechazo con ${code} y se esperaba BAD_NONCE: ${(err as Error).message}`);
  }

  const after = await client.minedNonce();
  after === before
    ? ok(`el nonce del hub no se movio (${after}): la adelantada no se ejecuto`)
    : fail(`el nonce del hub paso de ${before} a ${after} con la adelantada rechazada`);

  // Y la cadena sigue sana para el que manda en orden.
  currentTag = 'gap+';
  trace('gap+', 'arranca', `nonce hub ${free} (el que faltaba)  store(${value + 1})`);
  try {
    const relayed = await client.send({ to, data: storeData(value + 1), nonce: free });
    trace('gap+', 'OK', `nonce hub ${relayed.nonce}  bloque ${relayed.blockNumber}  tx ${shortHash(relayed.transactionHash)}`);
    const mined = await waitForHubNonce(client, free + 1);
    mined === free + 1
      ? ok(`la siguiente en orden (nonce ${free}) entro igual: el hueco no rompio la cadena`)
      : fail(`la siguiente en orden entro pero el nonce del hub quedo en ${mined} y se esperaba ${free + 1}`);
  } catch (err) {
    fail(`la siguiente en orden (nonce ${free}) fue rechazada con ${errorCode(err as Error)}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  VERBOSE = args.verbose;
  if (!args.to) throw new Error('Falta el contrato destino: --to 0x... o TARGET_ADDRESS en el .env');
  if (!process.env.USER_PRIVATE_KEY) throw new Error('Falta USER_PRIVATE_KEY en el .env');

  const res = await fetch(new URL('/info', args.url));
  if (!res.ok) throw new Error(`GET /info devolvio ${res.status}: no hay relayer en ${args.url}`);
  const relayer = (await res.json()) as Info & Record<string, unknown>;
  const reorderWindowMs = relayer.reorderWindowMs ?? 3_000;

  console.log(`relayer          : ${args.url}`);
  console.log(`writer node      : ${relayer.nodeAddress}`);
  console.log(`contrato destino : ${args.to}`);
  console.log(`secuencia        : ${args.n} metatx de a una (se espera el receipt de cada una)`);
  console.log(`nonce            : ${args.ask ? 'preguntado al relayer antes de cada metatx (--ask)' : 'contador del cliente, fijado en el send()'}`);
  console.log(
    `transporte       : ${args.transport === 'rpc' ? 'proxy JSON-RPC (POST /, como un dapp)' : 'REST (POST /relay)'}`,
  );
  console.log(`modo             : ${VERBOSE ? 'verboso (--quiet para el resumen solo)' : 'compacto'}`);

  if (VERBOSE) {
    console.log('\n/info completo del relayer:');
    for (const [k, v] of Object.entries(relayer)) console.log(`  ${k.padEnd(24)} ${JSON.stringify(v)}`);
  }

  const client = new TracingClient(process.env.USER_PRIVATE_KEY, args.url, { transport: args.transport });

  const [start, mined] = await Promise.all([client.nonce(), client.minedNonce()]);
  console.log(`\nusuario          : ${client.address} (nonce del hub ${mined})`);
  if (start !== mined) {
    // No es una falla de esta prueba: es alguien mas mandando metatx del mismo usuario, que es
    // justo el supuesto que la prueba necesita. Mejor decirlo antes que verlo como BAD_NONCE.
    info(`hay ${start - mined} metatx en vuelo (pending ${start}, minado ${mined}): se arranca en ${start}, pero conviene correrla con el usuario quieto`);
  }

  // Valores distintos en cada corrida: si no, `retrieve()` podria coincidir con lo que dejo la
  // corrida anterior y la verificacion pasaria sin que se haya escrito nada.
  const base = Date.now() % 1_000_000;

  console.log(`\nmandando ${args.n} metatx desde el nonce ${start}...\n`);
  CLOCK = Date.now();
  const steps = await runSequence(client, { to: args.to, n: args.n, ask: args.ask }, start, base);
  const totalMs = Date.now() - CLOCK;
  const signsInSequence = signCount;

  const okSteps = steps.filter((s) => s.ok);
  console.log(
    `\n${okSteps.length}/${args.n} aceptadas en ${totalMs} ms` +
      (okSteps.length > 0 ? ` (${(totalMs / okSteps.length).toFixed(0)} ms por metatx)` : ''),
  );

  if (VERBOSE && okSteps.length > 0) {
    const lat = okSteps.map((s) => s.ms).sort((a, b) => a - b);
    const gas = okSteps.reduce((acc, s) => acc + BigInt(s.relayed!.gasUsed), 0n);
    const blocks = new Set(okSteps.map((s) => s.relayed!.blockNumber));
    console.log(
      `latencia por metatx: min ${lat[0]} ms | p50 ${percentile(lat, 0.5)} ms | p90 ${percentile(lat, 0.9)} ms | max ${lat[lat.length - 1]} ms`,
    );
    console.log(`gas total: ${gas} | bloques tocados: ${blocks.size} (una metatx por bloque como maximo: se espera el receipt)`);

    console.log(`\ndetalle (${client.address}):`);
    for (const s of steps) {
      if (s.ok) {
        const r = s.relayed!;
        console.log(
          `  ${s.tag}  nonce ${String(r.nonce).padStart(4)}  bloque ${r.blockNumber}  gas ${String(r.gasUsed).padStart(7)}  ` +
            `${String(s.ms).padStart(5)} ms  ${r.executed ? 'ejecutada' : 'REVERTIDA'}  ` +
            `${simulationNote(r)}store(${s.value})  tx ${shortHash(r.transactionHash)}` +
            (r.events?.length ? `  eventos: ${r.events.join(',')}` : ''),
        );
      } else {
        console.log(`  ${s.tag}  RECHAZADA  ${s.code}  nonce ${s.nonce}  ${String(s.ms).padStart(5)} ms  ${s.message}`);
      }
    }
  }

  console.log('\nverificaciones:');

  okSteps.length === args.n
    ? ok(`las ${args.n} metatx entraron`)
    : fail(`solo entraron ${okSteps.length} de ${args.n}`);

  const nonces = okSteps.map((s) => s.relayed!.nonce);
  const gaps = nonces.filter((v, i) => v !== start + i);
  if (nonces.length === 0) {
    fail('ninguna metatx entro: no hay cadena que verificar');
  } else if (gaps.length > 0) {
    fail(`la cadena no es consecutiva desde ${start}: [${nonces.join(', ')}]`);
  } else {
    ok(`${nonces.length} nonces consecutivos ${start}..${start + nonces.length - 1}, en el orden en que se mandaron`);
  }

  // Una firma por metatx: con el nonce fijado el cliente no refirma, asi que mas de una firma
  // significaria que `send()` reintento por su cuenta.
  signsInSequence === steps.length
    ? ok(`una sola firma por metatx (${signsInSequence}): sin refirmas, el nonce lo puso el cliente`)
    : fail(`${signsInSequence} firmas para ${steps.length} metatx: hubo refirmas`);

  const finalNonce = await waitForHubNonce(client, start + okSteps.length);
  finalNonce === start + okSteps.length
    ? ok(`el nonce del hub quedo en ${finalNonce} (= ${start} + ${okSteps.length} minadas)`)
    : fail(`el nonce del hub quedo en ${finalNonce} y se esperaba ${start + okSteps.length}`);

  const executed = okSteps.filter((s) => s.relayed!.executed).length;
  executed === okSteps.length
    ? ok(`las ${executed} aceptadas se ejecutaron en el contrato destino`)
    : fail(`${okSteps.length - executed} aceptadas no ejecutaron la llamada del usuario`);

  if (okSteps.length > 0) {
    const last = okSteps[okSteps.length - 1];
    const stored = Number((await client.read(args.to, 'retrieve() view returns (uint256)'))[0]);
    stored === last.value
      ? ok(`retrieve() = ${stored}: quedo el valor de la ultima metatx, no el de otra`)
      : fail(`retrieve() = ${stored} y la ultima metatx escribio ${last.value}`);
  }

  const pending = await client.pendingCount();
  pending === 0
    ? ok('no quedaron metatx en vuelo (pending = 0)')
    : fail(`quedaron ${pending} metatx en vuelo`);

  // Cuantas se pre-simularon. La cadena en memoria del relayer sobrevive al ultimo receipt
  // `REORDER_WINDOW_MS` (esta ahi justamente para el cliente que sigue mandando), asi que en
  // secuencial rapido las siguientes salen igual que en una rafaga: encadenadas, sin simular.
  if (okSteps.some((s) => s.relayed!.simulated !== undefined)) {
    const simulated = okSteps.filter((s) => s.relayed!.simulated).length;
    info(
      `${simulated}/${okSteps.length} metatx pre-simuladas: solo se simula la que llega con la cadena vacia, ` +
        `y la cadena sobrevive ${reorderWindowMs} ms al ultimo receipt`,
    );
  } else {
    info('por el proxy JSON-RPC no se ve si el relayer simulo: el receipt no lo dice (con --rest si)');
  }

  if (args.gap) {
    if (okSteps.length === steps.length) {
      await runGap(client, args.to, start + okSteps.length, base + args.n, reorderWindowMs);
    } else {
      info('fase --gap salteada: la secuencia se corto antes y el nonce libre no es confiable');
    }
  }

  console.log(
    process.exitCode
      ? '\nprueba con fallas'
      : '\nprueba OK: mandando de a una y en orden, el relayer acepta todo sin reordenar ni refirmar',
  );
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
