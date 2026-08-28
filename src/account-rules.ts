/**
 * Permissioning de cuentas: contrato AccountRules de Besu/LACChain.
 *
 * En el modelo de gas de LAC-NET la transaccion que llega a la cadena la firma el WRITER NODE,
 * asi que el permissioning que aplica el nodo es sobre el writer node y no sobre el usuario de la
 * metatx: los usuarios normalmente NO estan en AccountRules (es justamente la gracia del modelo,
 * una cuenta sin permisos ni saldo puede escribir). Verificado en open-protestnet: el writer node
 * de `.env` esta permisionado y el usuario de prueba no, y sus metatx se relayan igual.
 *
 * De ahi que se use para dos cosas distintas:
 *
 *   1. Chequear al arrancar que el writer node esta permisionado. Si no lo esta, el nodo rechaza
 *      todos los `relayMetaTx` con "not authorized" y sin este chequeo el sintoma es un
 *      SEND_FAILED opaco en la primera metatx que alguien mande.
 *   2. Opcionalmente (`ENFORCE_ACCOUNT_RULES`) exigir que el usuario de la metatx tambien este
 *      permisionado. Es lo que hace el relay-signer en Go antes de relayar, y convierte a
 *      AccountRules en el allowlist del relayer. Va apagado por defecto porque en el modelo de gas
 *      los usuarios no tienen por que estar dados de alta.
 *
 * La direccion se resuelve como lo hace Besu: `AccountIngress.getContractAddress("rules")`.
 * Verificado con el ingress en `0x...8888`, que existe en open-protestnet (-> 0x23F9..F386) y en
 * lnet mainnet (-> 0x571d..51B4), los dos con `getContractVersion() = 1000000`.
 *
 * Se chequea con `accountPermitted(address)` y NO con `transactionAllowed(sender, target, ...)`:
 * en los dos deploys el segundo devuelve false incluso para el writer node permisionado y un
 * target permisionado (parece exigir que la llamada venga del propio ingress), asi que como
 * pre-chequeo rechazaria todo.
 */
import { Contract, JsonRpcProvider, ZeroAddress, encodeBytes32String, getAddress } from 'ethers';

/** El registry del ingress guarda el contrato de reglas bajo el nombre "rules". */
export const RULES_CONTRACT_NAME = encodeBytes32String('rules');

export const ACCOUNT_INGRESS_ABI = ['function getContractAddress(bytes32 name) view returns (address)'];

export const ACCOUNT_RULES_ABI = [
  'function accountPermitted(address account) view returns (bool)',
  'function getAccounts() view returns (address[])',
  'function getContractVersion() view returns (uint256)',
];

/** De donde salio la direccion del AccountRules. */
export type AccountRulesSource = 'config' | 'ingress';

/**
 * Consulta el permissioning de cuentas con un cache chico.
 *
 * El cache existe porque el permissioning cambia muy de vez en cuando y sin el se pagaria un
 * `eth_call` extra por metatx. La contrapartida: dar de alta una cuenta tarda hasta
 * `cacheMs` en verse. Se cachean tanto los `true` como los `false` (si no, un sender rechazado
 * pega un eth_call por request).
 */
export class AccountRules {
  private cache = new Map<string, { permitted: boolean; expiresAt: number }>();

  private constructor(
    private readonly contract: Contract,
    readonly address: string,
    readonly source: AccountRulesSource,
    private readonly cacheMs: number,
  ) {}

  /**
   * Resuelve el AccountRules de la cadena. Devuelve `null` cuando la cadena no lo expone
   * (no hay ingress desplegado, o el ingress no tiene registrado el contrato "rules"), que es el
   * caso de una devnet sin permissioning: ahi el chequeo simplemente no aplica.
   */
  static async resolve(
    provider: JsonRpcProvider,
    opts: { accountRulesAddress?: string; ingressAddress?: string; cacheMs: number },
  ): Promise<AccountRules | null> {
    if (opts.accountRulesAddress) {
      const address = getAddress(opts.accountRulesAddress);
      if ((await provider.getCode(address)) === '0x') {
        throw new Error(`ACCOUNT_RULES_ADDRESS=${address} has no code on this chain`);
      }
      return new AccountRules(new Contract(address, ACCOUNT_RULES_ABI, provider), address, 'config', opts.cacheMs);
    }

    if (!opts.ingressAddress) return null;
    const ingressAddress = getAddress(opts.ingressAddress);
    if ((await provider.getCode(ingressAddress)) === '0x') return null; // cadena sin permissioning

    const ingress = new Contract(ingressAddress, ACCOUNT_INGRESS_ABI, provider);
    const resolved: string = await ingress.getContractAddress(RULES_CONTRACT_NAME);
    if (resolved === ZeroAddress) return null; // ingress sin contrato de reglas registrado

    const address = getAddress(resolved);
    return new AccountRules(new Contract(address, ACCOUNT_RULES_ABI, provider), address, 'ingress', opts.cacheMs);
  }

  /** true si la cuenta esta dada de alta en AccountRules. Cachea el resultado `cacheMs`. */
  async permitted(account: string): Promise<boolean> {
    const address = getAddress(account);
    const hit = this.cache.get(address);
    const now = Date.now();
    if (hit !== undefined && hit.expiresAt > now) return hit.permitted;

    const permitted: boolean = await this.contract.accountPermitted.staticCall(address);
    this.cache.set(address, { permitted, expiresAt: now + this.cacheMs });
    return permitted;
  }

  /** Descarta lo cacheado de una cuenta (o de todas) para releer la cadena en la proxima consulta. */
  forget(account?: string): void {
    if (account === undefined) this.cache.clear();
    else this.cache.delete(getAddress(account));
  }
}
