/**
 * Cliente de ejemplo: manda una metatx al relayer interactuando con un contrato.
 *
 *   npm run client -- --to 0xContrato "store(uint256)" 42
 *   npm run client -- --to 0xContrato --read "retrieve() view returns (uint256)"
 *
 * Si no se pasa --to usa TARGET_ADDRESS del .env.
 */
import 'dotenv/config';
import { MetaTxClient } from './metatx';

function parseArgs(argv: string[]) {
  const out: { to?: string; read?: string; gasLimit?: bigint; rest: string[] } = { rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') out.to = argv[++i];
    else if (a === '--read') out.read = argv[++i];
    else if (a === '--gas') out.gasLimit = BigInt(argv[++i]);
    else out.rest.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const relayerUrl = process.env.RELAYER_URL ?? 'http://localhost:3001';
  const privateKey = process.env.USER_PRIVATE_KEY;
  const to = args.to ?? process.env.TARGET_ADDRESS;

  if (!privateKey) throw new Error('Missing USER_PRIVATE_KEY in .env');
  if (!to) throw new Error('Missing target contract: pass --to 0x... or set TARGET_ADDRESS');

  const client = new MetaTxClient(privateKey, relayerUrl, {
    expirationSeconds: Number(process.env.EXPIRATION_SECONDS ?? 86_400),
  });

  const info = await client.info();
  console.log(`relayer     : ${relayerUrl}`);
  console.log(`writer node : ${info.nodeAddress}`);
  console.log(`RelayHub    : ${info.relayHubAddress}`);
  console.log(`usuario     : ${client.address}`);
  console.log(`contrato    : ${to}`);

  if (args.read) {
    const result = await client.read(to, args.read);
    console.log(`\nlectura ${args.read} ->`, result.length === 1 ? result[0] : result);
    return;
  }

  const [signature, ...callArgs] = args.rest;
  if (!signature) {
    throw new Error('Pass the function to call, e.g. "store(uint256)" 42');
  }

  const nonce = await client.nonce();
  console.log(`nonce hub   : ${nonce}`);
  console.log(`\nenviando metatx ${signature} (${callArgs.join(', ')}) ...`);

  const result = await client.call(to, signature, callArgs, args.gasLimit);

  console.log('\n--- resultado ---');
  console.log(`tx del relayer : ${result.transactionHash}`);
  console.log(`bloque         : ${result.blockNumber}`);
  console.log(`ejecutada      : ${result.executed}`);
  console.log(`errorCode      : ${result.errorCodeName ?? 'n/d'}`);
  console.log(`gasUsed        : ${result.gasUsed}`);
  console.log(`eventos del hub: ${result.events.join(', ') || 'ninguno'}`);
  if (result.output && result.output !== '0x') console.log(`return data    : ${result.output}`);
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
