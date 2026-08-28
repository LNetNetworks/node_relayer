/**
 * Script de prueba end-to-end: despliega el contrato Storage por metatx y lo usa.
 *
 *   npm run test:deploy
 *   npm run test:deploy -- --forwarder 0xProxyDelRelayHub
 *
 * Pasos:
 *   1. deploy de Storage(trustedForwarder) via deployMetaTx  -> direccion del contrato
 *   2. owner() tiene que ser el usuario, no el RelayHub       -> prueba que _msgSender() funciona
 *   3. store(42) via relayMetaTx
 *   4. retrieve() tiene que devolver 42
 *
 * El usuario no paga gas en ningun paso: todo lo firma el writer node del relayer.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress } from 'ethers';
import { MetaTxClient } from './metatx';

interface Artifact {
  contractName: string;
  abi: any[];
  bytecode: string;
}

function loadStorageArtifact(): Artifact {
  const path = join(__dirname, '..', 'contracts', 'Storage.json');
  return JSON.parse(readFileSync(path, 'utf8')) as Artifact;
}

function parseArgs(argv: string[]) {
  const out: { forwarder?: string; value?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--forwarder') out.forwarder = argv[++i];
    else if (argv[i] === '--value') out.value = argv[++i];
  }
  return out;
}

const step = (n: number, msg: string) => console.log(`\n[${n}] ${msg}`);
const ok = (msg: string) => console.log(`    ok  ${msg}`);
const fail = (msg: string) => {
  console.error(`    FALLA  ${msg}`);
  process.exitCode = 1;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const relayerUrl = process.env.RELAYER_URL ?? 'http://localhost:3001';
  const privateKey = process.env.USER_PRIVATE_KEY;
  const newValue = BigInt(args.value ?? '42');

  if (!privateKey) {
    throw new Error(
      'Falta USER_PRIVATE_KEY en el .env (es la cuenta del usuario final, no necesita fondos)',
    );
  }

  const artifact = loadStorageArtifact();
  const client = new MetaTxClient(privateKey, relayerUrl, {
    expirationSeconds: Number(process.env.EXPIRATION_SECONDS ?? 86_400),
  });
  const info = (await client.info()) as any;

  // El trustedForwarder del contrato tiene que ser el PROXY del RelayHub, no el hub.
  const forwarder = getAddress(
    args.forwarder ?? process.env.TRUSTED_FORWARDER ?? info.relayHubProxyAddress,
  );

  console.log('--- prueba de deploy por metatx ---');
  console.log(`relayer          : ${relayerUrl}`);
  console.log(`writer node      : ${info.nodeAddress}`);
  console.log(`RelayHub         : ${info.relayHubAddress}`);
  console.log(`trustedForwarder : ${forwarder}`);
  console.log(`usuario          : ${client.address}`);
  console.log(`contrato         : ${artifact.contractName} (${(artifact.bytecode.length - 2) / 2} bytes de initcode)`);

  step(1, 'deploy de Storage por deployMetaTx');
  const deploy = await client.deploy({
    bytecode: artifact.bytecode,
    abi: artifact.abi,
    args: [forwarder],
  });
  console.log(`    tx del relayer  : ${deploy.transactionHash}`);
  console.log(`    bloque          : ${deploy.blockNumber}`);
  console.log(`    eventos del hub : ${deploy.events.join(', ') || 'ninguno'}`);
  if (!deploy.deployedAddress) {
    fail('el hub no emitio ContractDeployed: no hay direccion de contrato');
    return;
  }
  const storage = getAddress(deploy.deployedAddress);
  ok(`Storage desplegado en ${storage}`);

  step(2, 'owner() debe ser el usuario (verifica _msgSender via el forwarder)');
  const [owner] = await client.read(storage, 'owner() view returns (address)');
  getAddress(owner) === client.address
    ? ok(`owner = ${owner}`)
    : fail(`owner = ${owner}, se esperaba ${client.address} (revisar trustedForwarder)`);

  step(3, `store(${newValue}) por relayMetaTx`);
  const call = await client.call(storage, 'store(uint256)', [newValue]);
  console.log(`    tx del relayer  : ${call.transactionHash}`);
  console.log(`    ejecutada       : ${call.executed}`);
  console.log(`    eventos del hub : ${call.events.join(', ') || 'ninguno'}`);
  call.executed ? ok('el hub relayo y el contrato no revirtio') : fail('la llamada no se ejecuto');

  step(4, 'retrieve() debe devolver el valor guardado');
  const [stored] = await client.read(storage, 'retrieve() view returns (uint256)');
  BigInt(stored) === newValue ? ok(`retrieve() = ${stored}`) : fail(`retrieve() = ${stored}, se esperaba ${newValue}`);

  console.log(
    process.exitCode
      ? '\nla prueba termino con fallas'
      : `\nprueba OK - Storage en ${storage}, valor ${newValue}, el usuario no pago gas`,
  );
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
