/**
 * ABI y helpers del RelayHub (contrato TxRelay) del modelo de gas LAC-NET.
 *
 * La firma de `relayMetaTx` verificada contra el bytecode desplegado en lnet
 * (selector 0x1416862c) es la que lleva el gasLimit como primer parametro.
 */
import { Contract, JsonRpcProvider, Provider, Signer } from 'ethers';

export const RELAY_HUB_ABI = [
  'function relayMetaTx(uint256 gasLimit, bytes signingData, uint8 v, bytes32 r, bytes32 s) returns (uint8)',
  'function deployMetaTx(uint256 gasLimit, bytes signingData, uint8 v, bytes32 r, bytes32 s) returns (uint8, address)',
  'function getNonce(address from) view returns (uint256)',
  'function getMsgSender() view returns (address)',
  'function getGasLimit() view returns (uint256)',
  'function getCurrentGasLimit() view returns (uint256)',
  'function getMaxGasBlockLimit() view returns (uint256)',
  'event TransactionRelayed(address indexed relay, address indexed from, address indexed to, bool executed, bytes output)',
  'event ContractDeployed(address indexed relay, address indexed from, address contractDeployed)',
  'event BadTransactionSent(address node, address originalSender, uint8 errorCode)',
  'event GasUsedByTransaction(address node, uint256 blockNumber, uint256 gasUsed, uint256 gasLimit, uint256 gasUsedLastBlocks)',
  'event GasLimitExceeded(address node, uint256 blockNumber, uint8 countExceeded)',
];

/** El proxy publica cual es el RelayHub vigente (es el `trustedForwarder` de los contratos). */
export const RELAY_HUB_PROXY_ABI = ['function getRelayHub() view returns (address)'];

/** enum IRelayHub.ErrorCode, en orden. `OK` = 8. */
export const ERROR_CODES = [
  'MaxBlockGasLimit',
  'BadOriginalSender',
  'BadNonce',
  'NotEnoughGas',
  'IsNotContract',
  'EmptyCode',
  'InvalidSignature',
  'InvalidDestination',
  'OK',
] as const;

export const ERROR_CODE_OK = 8;

export function errorCodeName(code: number | bigint): string {
  return ERROR_CODES[Number(code)] ?? `Unknown(${code})`;
}

export function relayHubContract(address: string, runner: Provider | Signer): Contract {
  return new Contract(address, RELAY_HUB_ABI, runner);
}

/**
 * Resuelve la direccion del RelayHub. Si se configuro la direccion directa la usa;
 * si no, le pregunta al proxy (`getRelayHub()`), que es como lo hace el relay-signer oficial.
 */
export async function resolveRelayHubAddress(
  provider: JsonRpcProvider,
  opts: { relayHubAddress?: string; proxyAddress?: string },
): Promise<{ relayHubAddress: string; source: 'config' | 'proxy' }> {
  if (opts.relayHubAddress) {
    return { relayHubAddress: opts.relayHubAddress, source: 'config' };
  }
  if (!opts.proxyAddress) {
    throw new Error('Configura RELAY_HUB_ADDRESS o RELAY_HUB_PROXY_ADDRESS');
  }
  const proxy = new Contract(opts.proxyAddress, RELAY_HUB_PROXY_ABI, provider);
  const relayHubAddress: string = await proxy.getRelayHub();
  return { relayHubAddress, source: 'proxy' };
}
