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
  console.error(`    FAIL  ${msg}`);
  process.exitCode = 1;
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const relayerUrl = process.env.RELAYER_URL ?? 'http://localhost:3001';
  const privateKey = process.env.USER_PRIVATE_KEY;
  const newValue = BigInt(args.value ?? '42');

  if (!privateKey) {
    throw new Error(
      'Missing USER_PRIVATE_KEY in .env (the end user account, it needs no funds)',
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

  console.log('--- deploy-by-metatx test ---');
  console.log(`relayer          : ${relayerUrl}`);
  console.log(`writer node      : ${info.nodeAddress}`);
  console.log(`RelayHub         : ${info.relayHubAddress}`);
  console.log(`trustedForwarder : ${forwarder}`);
  console.log(`user             : ${client.address}`);
  console.log(`contract         : ${artifact.contractName} (${(artifact.bytecode.length - 2) / 2} bytes of initcode)`);

  step(1, 'deploying Storage through deployMetaTx');
  const deploy = await client.deploy({
    bytecode: artifact.bytecode,
    abi: artifact.abi,
    args: [forwarder],
  });
  console.log(`    relayer tx      : ${deploy.transactionHash}`);
  console.log(`    block           : ${deploy.blockNumber}`);
  console.log(`    hub events      : ${deploy.events.join(', ') || 'none'}`);
  if (!deploy.deployedAddress) {
    fail('the hub did not emit ContractDeployed: no contract address');
    return;
  }
  const storage = getAddress(deploy.deployedAddress);
  ok(`Storage desplegado en ${storage}`);

  step(2, 'owner() must be the user (verifies _msgSender through the forwarder)');
  const [owner] = await client.read(storage, 'owner() view returns (address)');
  getAddress(owner) === client.address
    ? ok(`owner = ${owner}`)
    : fail(`owner = ${owner}, expected ${client.address} (check trustedForwarder)`);

  step(3, `store(${newValue}) por relayMetaTx`);
  const call = await client.call(storage, 'store(uint256)', [newValue]);
  console.log(`    relayer tx      : ${call.transactionHash}`);
  console.log(`    executed        : ${call.executed}`);
  console.log(`    hub events      : ${call.events.join(', ') || 'none'}`);
  call.executed ? ok('the hub relayed and the contract did not revert') : fail('the call was not executed');

  step(4, 'retrieve() must return the stored value');
  const [stored] = await client.read(storage, 'retrieve() view returns (uint256)');
  BigInt(stored) === newValue ? ok(`retrieve() = ${stored}`) : fail(`retrieve() = ${stored}, expected ${newValue}`);

  console.log(
    process.exitCode
      ? '\nthe test finished with failures'
      : `\nprueba OK - Storage en ${storage}, valor ${newValue}, el usuario no pago gas`,
  );
}

main().catch((err) => {
  console.error(`\nError: ${err.message}`);
  process.exit(1);
});
