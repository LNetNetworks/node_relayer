import type { HardhatUserConfig } from 'hardhat/config';
import '@nomicfoundation/hardhat-ethers';
import 'dotenv/config';

/**
 * La red `lacchain` apunta al relayer, no al nodo: el relayer es un proxy JSON-RPC completo
 * (lecturas crudas al nodo, escrituras como metatx), asi que Hardhat lo usa como cualquier RPC.
 *
 * `gasPrice: 0` es parte del modelo de gas: en LAC-NET el gas no se paga y el hub rechaza
 * cualquier metatx con gasPrice distinto de 0.
 */
const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.20',
    settings: { optimizer: { enabled: false } },
  },
  networks: {
    lacchain: {
      url: process.env.RELAYER_URL ?? 'http://localhost:3001',
      gasPrice: 0,
      // Hardhat no firma nada: la metatx la firma LacchainSigner en el script.
      accounts: [],
    },
  },
};

export default config;
