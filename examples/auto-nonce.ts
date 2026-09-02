/**
 * Prueba del modo automatico del nonce (`AUTO_NONCE`). Corre sin nodo y sin red:
 *
 *   npm run test:auto-nonce
 *
 * No reemplaza a `npm run test:nonces` --esa es la prueba de carga contra una cadena de verdad--,
 * sino que cubre lo que aquella no puede provocar a mano: la carrera entre dos clientes del mismo
 * usuario pidiendo el nonce a la vez, el ticket que vence sin usarse y el batch de JSON-RPC.
 *
 * El `Relayer` se arma vacio (`Object.create`) con el estado fijado a mano: lo que se prueba es la
 * cola del handout, que no toca la cadena para nada.
 */
import { Relayer } from '../src/relayer';
import { RpcProxy } from '../src/rpc-proxy';

const USER = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';

let failures = 0;
function check(name: string, cond: boolean, extra = ''): void {
  console.log(`${cond ? '  ok  ' : '  FALLA'} ${name}${extra ? `  (${extra})` : ''}`);
  if (!cond) failures++;
}

/** Relayer con el handout vivo y todo lo demas apagado. `arrive` simula la metatx firmada. */
function makeRelayer(autoNonce: boolean, chainNonce: bigint, ticketMs = 300) {
  const r: any = Object.create(Relayer.prototype);
  r.cfg = { autoNonce, autoNonceTicketMs: ticketMs };
  r.inflight = new Map();
  r.handoutChain = new Map();
  r.tickets = new Map();
  r.getNonce = async () => chainNonce;
  r.nextNonce = async (u: string) => r.inflight.get(u)?.next ?? chainNonce;
  r.arrive = (user: string, nonce: bigint) => {
    r.inflight.set(user, { next: nonce + 1n, pending: 1 });
    const ticket = r.tickets.get(user);
    if (ticket && ticket.nonce === nonce) ticket.close('relay');
  };
  return r;
}

async function handout(): Promise<void> {
  console.log('\nhandout de nonces');

  // El comportamiento historico, que es el que sigue vigente con AUTO_NONCE=false.
  {
    const r = makeRelayer(false, 10n);
    const [a, b] = await Promise.all([r.handOutNonce(USER), r.handOutNonce(USER)]);
    check('sin AUTO_NONCE dos pedidos concurrentes reciben el mismo nonce', a === 10n && b === 10n, `${a} y ${b}`);
  }

  // Lo que arregla el modo automatico: el segundo espera y se lleva otro numero.
  {
    const r = makeRelayer(true, 10n);
    const first = await r.handOutNonce(USER);
    const secondP = r.handOutNonce(USER);
    let early = false;
    secondP.then(() => (early = true));
    await new Promise((res) => setTimeout(res, 30));
    check('el segundo pedido queda esperando el ticket', !early);
    r.arrive(USER, first);
    const second = await secondP;
    check('y recibe el nonce siguiente', first === 10n && second === 11n, `${first} y ${second}`);
  }

  // La diferencia con reservar del lado del cliente: un ticket sin usar no tapa el numero.
  {
    const r = makeRelayer(true, 10n, 120);
    const first = await r.handOutNonce(USER);
    const startedAt = Date.now();
    const second = await r.handOutNonce(USER);
    check(
      'un ticket vencido sin usar no deja hueco',
      first === 10n && second === 10n && Date.now() - startedAt >= 100,
      `${first} y ${second} tras ${Date.now() - startedAt} ms`,
    );
  }

  // Un rechazo tambien cierra el ticket: nadie paga el vencimiento entero por una metatx invalida.
  {
    const r = makeRelayer(true, 10n, 5_000);
    const first = await r.handOutNonce(USER);
    const startedAt = Date.now();
    const secondP = r.handOutNonce(USER);
    r.tickets.get(USER).close('relay');
    const second = await secondP;
    check(
      'un rechazo libera la cola sin esperar el vencimiento',
      second === first && Date.now() - startedAt < 100,
      `${second} tras ${Date.now() - startedAt} ms`,
    );
  }

  // La cola es por usuario: uno lento no puede frenar al resto.
  {
    const r = makeRelayer(true, 10n, 5_000);
    await r.handOutNonce(USER);
    const startedAt = Date.now();
    await r.handOutNonce(OTHER);
    check('el handout de otro usuario no espera', Date.now() - startedAt < 50);
  }

  // Los Map no pueden crecer con un entry por usuario que alguna vez pidio un nonce.
  {
    const r = makeRelayer(true, 10n, 60);
    await r.handOutNonce(USER);
    await new Promise((res) => setTimeout(res, 150));
    check(
      'la cola se limpia cuando se drena',
      r.handoutChain.size === 0 && r.tickets.size === 0,
      `colas=${r.handoutChain.size} tickets=${r.tickets.size}`,
    );
  }
}

async function batch(): Promise<void> {
  console.log('\nbatch de JSON-RPC');

  const calls: string[] = [];
  const relayer: any = {
    async handOutNonces(user: string, count: number) {
      calls.push(`handOutNonces(${count})`);
      const base = user === USER ? 10n : 50n;
      return Array.from({ length: count }, (_, i) => base + BigInt(i));
    },
    async handOutNonce(user: string) {
      calls.push('handOutNonce');
      return user === USER ? 10n : 50n;
    },
    async getNonce(user: string) {
      return user === USER ? 7n : 47n;
    },
  };
  const proxy = new RpcProxy(relayer, 'http://127.0.0.1:1');
  const pending = (id: number, address: string, block?: string) => ({
    jsonrpc: '2.0' as const,
    id,
    method: 'eth_getTransactionCount',
    params: block === undefined ? [address] : [address, block],
  });
  const results = async (body: unknown) =>
    new Map(((await proxy.handle(body)) as any[]).map((r) => [r.id, r.result ?? r.error]));

  // El caso que motiva el agrupado: un Promise.all de tres escrituras en ethers v6.
  {
    calls.length = 0;
    const byId = await results([pending(1, USER, 'pending'), pending(2, USER, 'pending'), pending(3, USER)]);
    check(
      'tres pedidos del mismo address reciben nonces consecutivos',
      byId.get(1) === '0xa' && byId.get(2) === '0xb' && byId.get(3) === '0xc',
      [...byId.values()].join(', '),
    );
    check('con un solo paso por el handout', calls.join(' ') === 'handOutNonces(3)', calls.join(' ') || 'ninguno');
  }

  {
    const byId = await results([pending(1, USER, 'pending'), pending(2, OTHER, 'pending'), pending(3, USER, 'pending')]);
    check(
      'cada address recibe su propia serie',
      byId.get(1) === '0xa' && byId.get(3) === '0xb' && byId.get(2) === '0x32',
      [...byId.values()].join(', '),
    );
  }

  // 'latest' es una lectura de lo minado, no un pedido para firmar: no toma nonce.
  {
    const byId = await results([pending(1, USER, 'latest'), pending(2, USER, 'pending')]);
    check("'latest' devuelve el minado y no entra al agrupado", byId.get(1) === '0x7' && byId.get(2) === '0xa', [...byId.values()].join(', '));
  }

  {
    const res: any = await proxy.handle(pending(9, USER, 'pending'));
    check('un pedido suelto sigue funcionando igual', res.result === '0xa', JSON.stringify(res.result ?? res.error));
  }
}

async function main(): Promise<void> {
  // El timer del ticket esta unref-eado, como el resto de los timers del relayer: en el server lo
  // sostiene el socket HTTP, aca hace falta algo que mantenga vivo el event loop.
  const keepAlive = setInterval(() => undefined, 1_000);
  console.log('modo automatico del nonce (AUTO_NONCE): prueba sin nodo');
  await handout();
  await batch();
  clearInterval(keepAlive);
  console.log(failures === 0 ? '\nprueba OK' : `\nprueba con ${failures} fallas`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
