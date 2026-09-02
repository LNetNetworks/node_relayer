/**
 * Deploy de Storage con Hardhat a traves del relayer, usando el LacchainSigner OFICIAL
 * (`@lacchain/gas-model-provider`) sin modificarlo.
 *
 * La gracia del ejemplo es esa: la misma libreria que usan los dapps contra el relay-signer de
 * LACChain apunta a este relayer y funciona igual. Lo unico que cambia es la URL.
 *
 *   npx hardhat run scripts/deploy.ts --network lacchain
 */
import { LacchainProvider, LacchainSigner } from '@lacchain/gas-model-provider';
import { Contract, ContractFactory, Wallet } from 'ethers';
import hre from 'hardhat';
import 'dotenv/config';

/**
 * El hub rechaza cualquier metatx que no sea legacy con gasPrice 0.
 *
 * En lnet no hace falta ponerlo: la red no reporta `baseFeePerGas` y `eth_gasPrice` devuelve 0,
 * asi que ethers ya arma una tx legacy con gasPrice 0 (probado: sin estos overrides el ejemplo
 * funciona igual). Va explicito igual porque `LacchainTransactionRequest` deja pasar `type`,
 * `gasPrice` y `maxFeePerGas` sin tocarlos: solo fuerza el chainId y el sufijo. O sea que si la
 * red algun dia reportara base fee, ethers armaria una tipo 2 y la metatx saldria mal formada.
 */
const GAS_MODEL_OVERRIDES = { type: 0, gasPrice: 0 } as const;

async function relayerInfo(url: string): Promise<{ nodeAddress: string; relayHubProxyAddress: string }> {
  const res = await fetch(new URL('/info', url));
  if (!res.ok) throw new Error(`GET /info devolvio ${res.status}. Esta corriendo el relayer en ${url}?`);
  return res.json() as Promise<{ nodeAddress: string; relayHubProxyAddress: string }>;
}

async function main() {
  const relayerUrl = process.env.RELAYER_URL ?? 'http://localhost:3001';
  const info = await relayerInfo(relayerUrl);
  const nodeAddress = process.env.NODE_ADDRESS?.trim() || info.nodeAddress;
  const expiration = Math.floor(Date.now() / 1000) + Number(process.env.EXPIRATION_SECONDS ?? 86_400);

  // El usuario no necesita fondos ni permisos: solo firma.
  const privateKey = process.env.USER_PRIVATE_KEY?.trim() || Wallet.createRandom().privateKey;

  const provider = new LacchainProvider(relayerUrl);
  const signer = new LacchainSigner(privateKey, provider, nodeAddress, expiration);

  console.log('--- deploy de Storage por metatx ---');
  console.log(`relayer     : ${relayerUrl}`);
  console.log(`writer node : ${nodeAddress}`);
  console.log(`usuario     : ${await signer.getAddress()}`);
  console.log(`chainId     : ${(await provider.getNetwork()).chainId}`);

  // Hardhat compila y nos da el artifact; el resto es ethers comun.
  const artifact = await hre.artifacts.readArtifact('Storage');

  // El trustedForwarder tiene que ser el PROXY del RelayHub, no el hub: BaseRelayRecipient le
  // hace staticcall a getRelayHub(), que el hub no tiene, y el constructor revierte.
  const forwarder = info.relayHubProxyAddress;
  console.log(`forwarder   : ${forwarder} (proxy del RelayHub)`);

  const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
  const contract = await factory.deploy(forwarder, GAS_MODEL_OVERRIDES);
  const receipt = await contract.deploymentTransaction()!.wait();

  // La direccion sale del RECEIPT, no de `await contract.getAddress()`: el contrato lo crea el
  // hub, asi que el getCreateAddress(from, nonce) que calcula ethers apunta a otro lado. El
  // relayer completa `contractAddress` leyendo el evento ContractDeployed del hub.
  const address = receipt?.contractAddress;
  if (address == null) throw new Error('el receipt no trae contractAddress');

  console.log(`\ndesplegado  : ${address}`);
  console.log(`tx del relay: ${receipt!.hash}  (bloque ${receipt!.blockNumber})`);

  // --- interactuar con el contrato recien desplegado, tambien por metatx ---
  const storage = new Contract(address, artifact.abi, signer);

  console.log(`\nretrieve()  : ${await storage.retrieve()}  (recien desplegado)`);

  const sent = await storage.store(42, GAS_MODEL_OVERRIDES);
  const storeReceipt = await sent.wait();
  console.log(`store(42)   : ${storeReceipt.hash} status=${storeReceipt.status}`);
  console.log(`retrieve()  : ${await storage.retrieve()}  (esperado 42)`);

  // owner se fijo en el constructor con _msgSender(): tiene que ser el usuario, no el writer node.
  const owner = await storage.owner();
  const user = await signer.getAddress();
  console.log(`\nowner()     : ${owner}`);
  console.log(`owner == usuario (no el writer node): ${owner === user}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('\nFallo el deploy:', err.message ?? err);
    process.exit(1);
  });
