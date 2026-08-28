import { JsonRpcProvider, Networkish, PerformActionRequest } from 'ethers';

/**
 * JsonRpcProvider adaptado a lnet/LACChain:
 *   - sin batching (los nodos rechazan requests batcheados)
 *   - limpia el campo `root` de los receipts (Besu lo devuelve y ethers no lo espera)
 *     y fuerza confirmations = 1 para que `tx.wait()` no se cuelgue.
 * Es el mismo ajuste que hace LacchainProvider de @lacchain/gas-model-provider.
 */
export class LnetProvider extends JsonRpcProvider {
  constructor(url: string, network?: Networkish) {
    super(url, network, { batchMaxSize: 1, staticNetwork: true });
  }

  async _perform(req: PerformActionRequest): Promise<any> {
    const result = await super._perform(req);
    if (req.method === 'getTransactionReceipt' && result) {
      delete (result as any).root;
      (result as any).confirmations = 1;
    }
    return result;
  }
}
