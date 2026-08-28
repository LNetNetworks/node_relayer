/**
 * Reglas del modelo de gas LAC-NET compartidas por cliente y relayer.
 *
 * Una metatx de LAC-NET es una transaccion legacy (tipo 0) normal donde:
 *   - chainId  = 0            -> la firma NO es EIP-155, `signingData` queda en 6 campos RLP
 *   - gasPrice = 0            -> en LAC-NET el gas no se paga
 *   - value    = 0            -> el RelayHub siempre hace la llamada con value 0
 *   - nonce    = RelayHub.getNonce(user) visto por el writer node (NO el nonce de la cuenta)
 *   - data     = calldata original + abi.encode(['address','uint256'], [nodeAddress, expiration])
 *
 * El usuario firma keccak(RLP([nonce, gasPrice, gasLimit, to, value, data])), que es exactamente
 * `tx.unsignedHash` de ethers, y ese mismo RLP es el `signingData` que espera el RelayHub.
 */
import { AbiCoder, getAddress, Transaction } from 'ethers';

/** abi.encode(address,uint256) = 2 palabras = 64 bytes al final del data. */
export const GAS_MODEL_SUFFIX_BYTES = 64;

const abi = AbiCoder.defaultAbiCoder();

/** Agrega (nodeAddress, expiration) al final del calldata original. */
export function appendGasModelSuffix(data: string, nodeAddress: string, expiration: number | bigint): string {
  const suffix = abi.encode(['address', 'uint256'], [getAddress(nodeAddress), expiration]).slice(2);
  return (data === '0x' ? '0x' : data) + suffix;
}

/** Separa el calldata original de los 64 bytes del modelo de gas. */
export function decodeGasModelSuffix(data: string): {
  innerData: string;
  nodeAddress: string;
  expiration: bigint;
} {
  const body = data.startsWith('0x') ? data.slice(2) : data;
  const hexSuffixLen = GAS_MODEL_SUFFIX_BYTES * 2;
  if (body.length < hexSuffixLen) {
    throw new Error(
      `data demasiado corto (${body.length / 2} bytes): falta el sufijo (nodeAddress, expiration) del modelo de gas`,
    );
  }
  const suffix = '0x' + body.slice(body.length - hexSuffixLen);
  const [nodeAddress, expiration] = abi.decode(['address', 'uint256'], suffix);
  return {
    innerData: '0x' + body.slice(0, body.length - hexSuffixLen),
    nodeAddress: getAddress(nodeAddress),
    expiration: expiration as bigint,
  };
}

/**
 * Gas de la metatx tal como lo calcula el relay-signer oficial:
 *   len(data) * 105 + 300000 + gasLimit del usuario
 * (el overhead cubre el calldata, el RLP-decode dentro del hub y la contabilidad de gas).
 */
export function metaTxGasLimit(data: string, userGasLimit: bigint): bigint {
  const dataBytes = BigInt((data.length - 2) / 2);
  return dataBytes * 105n + 300_000n + userGasLimit;
}

/**
 * Ventana minima de expiration que exige el relayer por defecto (`MIN_EXPIRATION_SECONDS`).
 * Vive aca, con el resto de las reglas del modelo, para que el cliente pueda mirarla sin
 * importar nada del servidor.
 */
export const DEFAULT_MIN_EXPIRATION_SECONDS = 300;

/**
 * Tolerancia por defecto con la que se aplica ese minimo (`EXPIRATION_LATENCY_TOLERANCE_SECONDS`).
 * Un cliente que firma `ahora + 300` no puede llegar con 300 s: se pierde la latencia del POST
 * (hasta ~1 s) y hasta 1 s mas en el `floor` a segundos de cada lado. Sin esta holgura, firmar
 * exactamente el minimo se rechazaria casi siempre. Subirla si la red es mas lenta que eso.
 */
export const DEFAULT_EXPIRATION_TOLERANCE_SECONDS = 2;

/** Expiracion por defecto: ahora + `seconds`. */
export function expirationFromNow(seconds: number): number {
  return Math.floor(Date.now() / 1000) + seconds;
}

/**
 * Chequeos de forma sobre una metatx ya deserializada. Devuelve la lista de problemas
 * (vacia = todo bien) para poder responder al cliente con un error util.
 */
export function validateMetaTxShape(tx: Transaction): string[] {
  const problems: string[] = [];
  if (tx.signature == null) problems.push('la transaccion no viene firmada');
  if (tx.type !== 0) problems.push(`type debe ser 0 (legacy), llego ${tx.type}`);
  if (tx.chainId !== 0n) problems.push(`chainId debe ser 0, llego ${tx.chainId}`);
  if ((tx.gasPrice ?? 0n) !== 0n) problems.push(`gasPrice debe ser 0, llego ${tx.gasPrice}`);
  if (tx.value !== 0n) problems.push(`value debe ser 0, llego ${tx.value}`);
  if (tx.gasLimit <= 0n) problems.push('gasLimit debe ser > 0');
  return problems;
}
