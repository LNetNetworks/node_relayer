/**
 * Self-test del modelo de gas, sin gastar nada y sin necesitar la clave de un writer node.
 *
 * Arma una metatx con claves dummy y le pregunta al RelayHub real, por eth_call, si la
 * aceptaria. Si devuelve OK (8) significa que el hub verifico la firma ECDSA sobre
 * `signingData`, el nonce y el destino: la parte delicada del modelo de gas esta bien.
 *
 *   RPC_URL=http://34.73.228.200 npm run selftest
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Contract, Interface, Transaction, Wallet, ZeroAddress, getAddress } from 'ethers';
import { LnetProvider } from './provider';
import {
  RELAY_HUB_ABI,
  ERROR_CODE_OK,
  errorCodeName,
  resolveRelayHubAddress,
} from './relayhub';
import {
  appendGasModelSuffix,
  decodeGasModelSuffix,
  expirationFromNow,
  metaTxGasLimit,
  validateMetaTxShape,
} from './gas-model';

/** Lee una address del entorno tratando el string vacio como no definida. */
const envAddress = (name: string): string | undefined => {
  const v = process.env[name]?.trim();
  return v ? getAddress(v) : undefined;
};

const ok = (msg: string) => console.log(`  ok  ${msg}`);
const fail = (msg: string) => {
  console.error(`  FAIL  ${msg}`);
  process.exitCode = 1;
};

async function main() {
  const rpcUrl = process.env.RPC_URL ?? 'http://34.73.228.200';
  const provider = new LnetProvider(rpcUrl);
  const network = await provider.getNetwork();
  console.log(`RPC ${rpcUrl} (chainId ${network.chainId})`);

  const proxyAddress =
    envAddress('RELAY_HUB_PROXY_ADDRESS') ?? getAddress('0xEAA5420AF59305c5ecacCB38fcDe70198001d147');
  const { relayHubAddress, source } = await resolveRelayHubAddress(provider, {
    relayHubAddress: envAddress('RELAY_HUB_ADDRESS'),
    proxyAddress,
  });
  const hub = new Contract(getAddress(relayHubAddress), RELAY_HUB_ABI, provider);
  console.log(`RelayHub ${relayHubAddress} (via ${source})`);
  console.log(`gas available in the block: ${(await hub.getCurrentGasLimit()).toString()}\n`);

  // Claves dummy: solo se usan para firmar, nunca para enviar.
  const node = new Wallet('0x' + '22'.repeat(32));
  const user = new Wallet('0x' + '33'.repeat(32));

  const nonce: bigint = await hub.getNonce.staticCall(user.address, { from: node.address });
  ok(`getNonce with from = node returns ${nonce}`);

  const target = envAddress('TARGET_ADDRESS') ?? getAddress(relayHubAddress);
  const iface = new Interface(['function store(uint256)']);
  const inner = iface.encodeFunctionData('store', [42]);
  const expiration = expirationFromNow(3600);
  const data = appendGasModelSuffix(inner, node.address, expiration);

  const tx = Transaction.from({
    type: 0,
    chainId: 0,
    nonce: Number(nonce),
    gasPrice: 0,
    gasLimit: 100_000,
    to: target,
    value: 0,
    data,
  });
  tx.signature = user.signingKey.sign(tx.unsignedHash);
  const rawTx = tx.serialized;

  // A partir de aca hacemos exactamente lo que hace el relayer con la raw tx.
  const decoded = Transaction.from(rawTx);
  const problems = validateMetaTxShape(decoded);
  problems.length === 0 ? ok('the metatx matches the gas model shape') : fail(problems.join('; '));
  decoded.from === user.address
    ? ok(`from recovered from the signature: ${decoded.from}`)
    : fail(`from recuperado ${decoded.from} != ${user.address}`);

  const suffix = decodeGasModelSuffix(decoded.data);
  suffix.nodeAddress === node.address && suffix.innerData === inner
    ? ok(`suffix (nodeAddress, expiration) = (${suffix.nodeAddress}, ${suffix.expiration})`)
    : fail('the gas model suffix does not decode correctly');

  const signingData = decoded.unsignedSerialized;
  signingData === tx.unsignedSerialized
    ? ok('signingData = 6-field RLP, identical before and after serializing')
    : fail('signingData does not round-trip');

  const { v, r, s } = decoded.signature!;
  const gasLimit = metaTxGasLimit(decoded.data, decoded.gasLimit);
  ok(`v = ${v} (27/28 => non-EIP-155 signature, as the hub requires)`);
  ok(`metaTxGasLimit = ${gasLimit}`);

  const code: bigint = await hub.relayMetaTx.staticCall(gasLimit, signingData, v, r, s, {
    from: node.address,
    gasPrice: 0,
    gasLimit,
  });
  Number(code) === ERROR_CODE_OK
    ? ok(`the RelayHub answers ${errorCodeName(code)}: it would accept this metatx`)
    : fail(`the RelayHub answers ${errorCodeName(code)}`);

  // ---- mismo chequeo para el camino de deploy (deployMetaTx, to = null) ----
  console.log('\ndeploy (deployMetaTx):');
  const artifact = JSON.parse(
    readFileSync(join(__dirname, '..', 'contracts', 'Storage.json'), 'utf8'),
  ) as { abi: any[]; bytecode: string };
  const storageIface = new Interface(artifact.abi);
  // El trustedForwarder tiene que ser el PROXY: si se le pasa el hub, getRelayHub() no existe
  // ahi, el abi.decode del staticcall revierte y el constructor se cae (direccion 0x0).
  const initcode = artifact.bytecode + storageIface.encodeDeploy([proxyAddress]).slice(2);
  const deployData = appendGasModelSuffix(initcode, node.address, expiration);

  const deployTx = Transaction.from({
    type: 0,
    chainId: 0,
    nonce: Number(nonce),
    gasPrice: 0,
    gasLimit: 900_000,
    to: null,
    value: 0,
    data: deployData,
  });
  deployTx.signature = user.signingKey.sign(deployTx.unsignedHash);
  const deployDecoded = Transaction.from(deployTx.serialized);
  deployDecoded.to === null && deployDecoded.from === user.address
    ? ok('deploy metatx: empty to in the RLP and from recovered from the signature')
    : fail('the deploy metatx does not round-trip');

  const deployGasLimit = metaTxGasLimit(deployDecoded.data, deployDecoded.gasLimit);
  const deploySig = deployDecoded.signature!;
  const deployResult = await hub.deployMetaTx.staticCall(
    deployGasLimit,
    deployDecoded.unsignedSerialized,
    deploySig.v,
    deploySig.r,
    deploySig.s,
    { from: node.address, gasPrice: 0, gasLimit: deployGasLimit },
  );
  const wouldDeployAt = getAddress(deployResult[1] as string);
  Number(deployResult[0]) === ERROR_CODE_OK && wouldDeployAt !== ZeroAddress
    ? ok(`the hub answers ${errorCodeName(deployResult[0])} and would create the contract at ${wouldDeployAt}`)
    : fail(
        `the hub answers ${errorCodeName(deployResult[0])} and would create ${wouldDeployAt} ` +
          '(0x0 = the constructor reverted with the extra 64 bytes of the gas model)',
      );

  console.log(
    process.exitCode ? '\nself-test with failures' : '\nself-test OK (no transaction was sent)',
  );
}

main().catch((err) => {
  console.error(`\nError: ${err.shortMessage ?? err.message}`);
  process.exit(1);
});
