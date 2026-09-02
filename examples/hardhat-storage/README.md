# Deploy de Storage con Hardhat por metatx

Despliega `Storage.sol` y le escribe, todo a traves del relayer, usando el
**`LacchainSigner` oficial de `@lacchain/gas-model-provider` sin modificar**.

Esa es la gracia del ejemplo: la misma libreria que usan los dapps contra el relay-signer de
LACChain apunta a este relayer y funciona igual. Lo unico que cambia es la URL.

```ts
const provider = new LacchainProvider(RELAYER_URL);
const signer = new LacchainSigner(PRIVATE_KEY, provider, NODE_ADDRESS, EXPIRATION);

const factory = new ContractFactory(artifact.abi, artifact.bytecode, signer);
const contract = await factory.deploy(forwarder, { type: 0, gasPrice: 0 });
```

## Correrlo

Con el relayer levantado (`npm start` en la raiz del repo):

```sh
npm install
npm run compile
RELAYER_URL=http://localhost:3001 npm run deploy
```

Salida esperada:

```
--- deploy de Storage por metatx ---
relayer     : http://localhost:3001
writer node : 0x248906Bf539e8f16FbD14c001f7Bd3D712f95D3E
usuario     : 0x0255F6F1976d8476CF127a0B1c2971e9a06c9eE1
chainId     : 648540
forwarder   : 0xa4B5eE2906090ce2cDbf5dfff944db26f397037D (proxy del RelayHub)

desplegado  : 0x51C99a2edB680e4124768c406e079E6C722112f7
tx del relay: 0x86d09a7f...  (bloque 61507078)

retrieve()  : 0  (recien desplegado)
store(42)   : 0x3d95a700... status=1
retrieve()  : 42  (esperado 42)

owner()     : 0x0255F6F1976d8476CF127a0B1c2971e9a06c9eE1
owner == usuario (no el writer node): true
```

El usuario **no necesita fondos ni permisos**: solo firma. Si no se define
`USER_PRIVATE_KEY` el script genera una cuenta al vuelo, y funciona igual.

Esa ultima linea es la que prueba que el modelo de gas anda de punta a punta: `owner` se fija en
el constructor con `_msgSender()`, asi que si diera el writer node en vez del usuario, el relay
estaria roto.

## Configuracion

Ver `.env.example`. Lo unico obligatorio es `RELAYER_URL`; el writer node y el forwarder se
resuelven preguntandole a `GET /info` del relayer.

En `hardhat.config.ts` la red `lacchain` apunta al **relayer**, no al nodo: el relayer es un proxy
JSON-RPC completo, asi que Hardhat lo usa como cualquier RPC. `accounts: []` porque Hardhat no
firma nada aca: la metatx la firma el `LacchainSigner`.

## Dos cosas que hay que saber

### La direccion del contrato sale del receipt

`await contract.getAddress()` **no sirve** para deploys en este modelo. Ethers la calcula con
`getCreateAddress(from, nonce)` sobre la tx que ve, y la que ve es la del writer node al hub. El
contrato lo crea el hub, en otra direccion.

La direccion real esta en `receipt.contractAddress`, que el relayer completa leyendo el evento
`ContractDeployed`. Es tambien lo que hace el README del paquete oficial:

```ts
const receipt = await contract.deploymentTransaction()!.wait();
const address = receipt!.contractAddress;
```

### El trustedForwarder es el proxy, no el hub

El constructor de `Storage` recibe el **proxy** del RelayHub. `BaseRelayRecipient` le hace
`staticcall` de `getRelayHub()` al forwarder; el hub no tiene esa funcion, asi que si le pasas el
hub el `abi.decode` revierte y el constructor se cae (el deploy devuelve direccion `0x0`).

El script lo toma de `relayHubProxyAddress` de `GET /info`.
