# simple_relay

Relayer minimo (Node + TypeScript + ethers v6) para el **modelo de gas de LAC-NET / lnet**.
El usuario firma una metatx sin pagar gas, este servicio la envuelve en una llamada a
`RelayHub.relayMetaTx(...)` firmada por la clave de un writer node, y el contrato destino
recupera al usuario original con `_msgSender()`.

```
   usuario                       simple_relay                        lnet (Besu)
      |                               |                                  |
      |  1. firma metatx              |                                  |
      |     chainId 0, gasPrice 0     |                                  |
      |     data = calldata +         |                                  |
      |            (nodeAddress,exp)  |                                  |
      |------ POST /relay {rawTx} --->|                                  |
      |                               | 2. valida forma, nodeAddress,    |
      |                               |    expiracion y nonce del hub    |
      |                               | 3. relayMetaTx(gasLimit,         |
      |                               |      signingData, v, r, s) ----->| TxRelay
      |                               |                                  |   |
      |                               |                                  |   v
      |                               |                                  | contrato destino
      |                               |                                  | (_msgSender() = usuario)
      |<---- txHash + resultado ------|<---------------------------------|
```

## Como es una metatx de LAC-NET

Es una transaccion legacy (tipo 0) comun, con estas particularidades:

| campo | valor |
|---|---|
| `chainId` | `0` -> la firma **no** es EIP-155, asi el `signingData` queda en 6 campos RLP y `v` es 27/28 |
| `gasPrice` | `0` -> en LAC-NET el gas no se paga |
| `value` | `0` -> el hub siempre hace la llamada con value 0 |
| `nonce` | `RelayHub.getNonce(user)` **visto por el writer node**, no el nonce de la cuenta (ver [Nonces y concurrencia](#nonces-y-concurrencia)) |
| `data` | calldata original + `abi.encode(['address','uint256'], [nodeAddress, expiration])` (64 bytes) |

Lo que el usuario firma es `keccak(RLP([nonce, gasPrice, gasLimit, to, value, data]))`, que en
ethers es exactamente `tx.unsignedHash`; ese mismo RLP es el `signingData` que recibe el hub.
El relayer no necesita re-encodear nada a mano: `Transaction.from(rawTx).unsignedSerialized`.

## Estructura

```
src/gas-model.ts   reglas del modelo de gas (sufijo, gasLimit, validaciones) - cliente y servidor
src/relayhub.ts    ABI del RelayHub (TxRelay), enum ErrorCode, resolucion via proxy
src/account-rules.ts  permissioning de cuentas (AccountRules) resuelto via AccountIngress
src/provider.ts    JsonRpcProvider adaptado a lnet (sin batching, limpia `root` de los receipts)
src/relayer.ts     nucleo: raw tx -> validaciones -> relayMetaTx -> resultado decodificado
src/server.ts      HTTP: REST simple + JSON-RPC drop-in
src/rpc-proxy.ts   proxy JSON-RPC: lecturas al nodo, escrituras como metatx, batches
src/ws-proxy.ts    lo mismo sobre WebSocket + eth_subscribe/eth_unsubscribe
src/metatx.ts      lado cliente: arma, firma y manda la metatx
src/client.ts      CLI de ejemplo
src/selftest.ts    verifica el modelo de gas contra el hub real por eth_call, sin gastar nada
src/deploy-storage.ts  prueba end-to-end: deploy de Storage + store/retrieve por metatx
contracts/         Storage.sol + BaseRelayRecipient.sol y el artifact compilado (abi + bytecode)
examples/hardhat-storage/  deploy con Hardhat usando el LacchainSigner oficial
examples/nonce-stress.ts   prueba de carga del manejo de nonces (rafagas simultaneas)
COMPARACION-GO-NODE.md     comparacion detallada con el relay-signer en Go
```

## Uso

```sh
git clone git@github.com:LNetNetworks/node_relayer.git
cd node_relayer
npm install
cp .env.example .env    # completar RPC_URL y NODE_PRIVATE_KEY
npm run selftest        # opcional: valida el armado de la metatx contra el hub real
npm start               # levanta el relayer (npm run dev para watch)
```

Mandar una metatx con el cliente de ejemplo:

```sh
# escribe: store(42) en el contrato destino, pagando gas el writer node
npm run client -- --to 0xTuContrato "store(uint256)" 42

# lee (eth_call normal, sin relay)
npm run client -- --to 0xTuContrato --read "retrieve() view returns (uint256)"
```

### Prueba end-to-end (deploy + interaccion)

`src/deploy-storage.ts` no es un test unitario: es una prueba end-to-end contra la cadena real.
Despliega un contrato y le escribe, todo por metatx y sin que el usuario pague gas.

**1. Levantar el relayer** (en otra terminal) y verificar que responde:

```sh
npm start
curl -s localhost:3001/info
```

```json
{
  "nodeAddress": "0x2489...5D3E",
  "relayHubAddress": "0xB9e9...E475",
  "relayHubSource": "proxy",
  "relayHubProxyAddress": "0xa4B5...037D",
  "chainId": "648540",
  "currentGasLimit": "96000000"
}
```

**2. Correr la prueba:**

```sh
npm run test:deploy                                   # value 42, forwarder = proxy del relayer
npm run test:deploy -- --value 7                      # otro valor
npm run test:deploy -- --forwarder 0xProxy --value 7  # forwarder explicito
```

**Variables que usa** (todas del `.env`, ninguna obligatoria salvo la clave del usuario):

| variable | default | para que |
|---|---|---|
| `USER_PRIVATE_KEY` | — (obligatoria) | cuenta del usuario final; **no necesita fondos** |
| `RELAYER_URL` | `http://localhost:3001` | a donde manda las metatx |
| `TRUSTED_FORWARDER` | `relayHubProxyAddress` de `/info` | forwarder del constructor de `Storage` |
| `EXPIRATION_SECONDS` | `86400` | vigencia de la metatx |

`--forwarder` y `--value` pisan a `TRUSTED_FORWARDER` y al valor por default.

**Que hace y que mirar.** Cada paso imprime `ok` o `FALLA`, y el proceso sale con codigo != 0
si alguno falla:

1. deploy de `Storage(trustedForwarder)` con `deployMetaTx` -> direccion del evento `ContractDeployed`
2. `owner()` tiene que ser **el usuario** y no el RelayHub: eso prueba que `_msgSender()` resuelve bien
3. `store(N)` con `relayMetaTx` -> `executed: true`
4. `retrieve()` tiene que devolver `N`

Salida esperada de una corrida OK:

```
[1] deploy de Storage por deployMetaTx
    tx del relayer  : 0x...
    eventos del hub : ContractDeployed
    ok  Storage desplegado en 0x...
[2] owner() debe ser el usuario (verifica _msgSender via el forwarder)
    ok  owner = 0x...
[3] store(42) por relayMetaTx
    ejecutada       : true
    ok  el hub relayo y el contrato no revirtio
[4] retrieve() debe devolver el valor guardado
    ok  retrieve() = 42

prueba OK - Storage en 0x..., valor 42, el usuario no pago gas
```

El contrato de prueba (`contracts/Storage.sol`, con su artifact ya compilado en
`contracts/Storage.json`) es el mismo del proyecto `lacchain-vault-storage`: hereda
`BaseRelayRecipient` y usa `_msgSender()`.

#### Si falla

| sintoma | causa probable |
|---|---|
| `Falta USER_PRIVATE_KEY en el .env` | falta la clave del usuario final (no la del node) |
| `ECONNREFUSED` / no responde | el relayer no esta levantado, o `RELAYER_URL` apunta a otro puerto que `PORT` |
| paso 1: `el hub no emitio ContractDeployed` | el writer node no esta dado de alta (`addNode`) o no tiene cupo de gas -> `NotEnoughGas` |
| paso 1 devuelve direccion `0x0` | el `trustedForwarder` es el **hub** y no el **proxy** (ver "Detalles que cuestan iteraciones") |
| paso 2: `owner` = el RelayHub | idem: `_msgSender()` no resuelve porque el forwarder esta mal |
| paso 3: `ejecutada: false` | el hub relayo pero `store()` revirtio en el contrato destino |

Para validar el armado de la metatx contra el hub real **sin gastar un bloque**, correr antes
`npm run selftest`: hace todo por `eth_call`.

> El default de `RELAYER_URL` hardcodeado en `deploy-storage.ts` es `:3001`, mientras que el de
> `.env.example` es `:3000`. Si cambias `PORT`, acordate de mover tambien `RELAYER_URL`.
O a mano:

```sh
curl -s localhost:3000/info
curl -s localhost:3000/nonce/0xUsuario
curl -s -X POST localhost:3000/relay -H 'Content-Type: application/json' -d '{"rawTx":"0xf8..."}'
```

### Endpoints

| metodo | ruta | que hace |
|---|---|---|
| POST | `/` | **proxy JSON-RPC**: lecturas crudas al nodo, escrituras como metatx (ver abajo) |
| WS | `/` | lo mismo sobre WebSocket, mas `eth_subscribe` / `eth_unsubscribe` |
| GET | `/info` | writer node, RelayHub, chainId, gas disponible en el bloque, AccountRules y si el node esta permisionado |
| GET | `/nonce/:address` | `nonce` minado, `nextNonce` (contando metatx en vuelo, es el que hay que firmar) y `pending` |
| POST | `/relay` | `{ "rawTx": "0x..." }` -> relaya y devuelve el resultado decodificado |

## Proxy JSON-RPC

`POST /` es un endpoint JSON-RPC completo: un dapp apunta ahi su provider y funciona sin cambios.
Las **lecturas van crudas al nodo** y las **escrituras se relayan como metatx**.

Tres metodos no pueden ir crudos:

| metodo | por que se intercepta |
|---|---|
| `eth_sendRawTransaction` | la raw tx es una metatx (chainId 0, gasPrice 0) y el nodo la rechazaria. Se relaya y **devuelve el hash sin esperar el receipt**, que es lo que espera un cliente JSON-RPC |
| `eth_getTransactionCount` | el nonce que importa es el del RelayHub, no el de la cuenta. `pending` (default) cuenta lo que el relayer tiene en vuelo; `latest` devuelve solo lo minado |
| `eth_getTransactionReceipt` | el receipt crudo es el de la tx del writer node **al hub**: dice `status: 1` aunque la llamada del usuario haya revertido, y `contractAddress: null` en los deploys |

Todo lo demas (`eth_call`, `eth_getLogs`, `eth_blockNumber`, `eth_estimateGas`, `eth_chainId`, ...)
va tal cual al nodo. `eth_sendTransaction` / `eth_sign` devuelven un error explicito: el relayer no
custodia la clave del usuario, la metatx se firma del lado del cliente. `eth_accounts` devuelve `[]`.

### Reescritura del receipt

Sobre el receipt del nodo se aplica:

- `ContractDeployed` -> se completa `contractAddress` con la direccion real del deploy.
- `TransactionRelayed` con `executed: false` -> `status: 0x0` y se agrega `revertReason`.
- `BadTransactionSent` -> `status: 0x0` y se agregan `relayErrorCode` / `relayErrorCodeName`.

Los dos primeros son lo mismo que hace el relay-signer en Go. El tercero es un agregado: cuando el
hub **rechaza** la metatx no la ejecuta, y devolver `status: 1` ahi seria mentirle al dapp.

### Batches

Los batches se parten y se rutean metodo por metodo, y las lecturas del batch se reagrupan en un
solo request al nodo. Es necesario: **ethers v6 batchea por defecto**, y reenviar el body entero
dejaria pasar un `eth_sendRawTransaction` derecho al nodo, salteandose el relayer.

### CORS

`CORS_ORIGIN` (default `*`) habilita las cabeceras para dapps de browser. Vacio las desactiva, si
hay un gateway adelante que ya las pone.

## WebSocket y eth_subscribe

El mismo puerto acepta conexiones WebSocket (`ws://localhost:3000`), con el mismo ruteo que en
HTTP mas `eth_subscribe` / `eth_unsubscribe`. Un `WebSocketProvider` de ethers funciona sin
cambios: lecturas, escrituras y `provider.on('block', ...)` sobre un solo socket.

`WS_URL` apunta al WebSocket del nodo. Si se deja vacio se deriva del RPC (mismo host, puerto + 1),
que es la convencion de Besu (8545/8546, 4545/4546) y la que usa el relay-signer en Go.

**Una conexion al nodo por dapp conectado**, abierta recien en la primera suscripcion. Es a
proposito: con un upstream compartido habria que reescribir los ids de suscripcion y llevar
refcount por topico (dos clientes suscriptos a `newHeads` compartirian una sola suscripcion arriba,
y el `unsubscribe` de uno le cortaria el feed al otro). Con un upstream por cliente los ids son
1:1, las notificaciones se reenvian tal cual y cerrar el cliente limpia todo solo.

Comportamiento ante fallos:

- **El nodo no expone WS**: `eth_subscribe` devuelve un error explicito y el resto del socket sigue
  funcionando (lecturas y escrituras andan igual). El intento de conexion tiene techo
  `WS_CONNECT_TIMEOUT_MS` (10 s); sin el se cae en el timeout de TCP del SO, que son ~75 s con el
  dapp colgado.
- **El WS del nodo se cae con suscripciones vivas**: se le cierra el socket al cliente con codigo
  1012 (*Service Restart*), para que su provider reconecte y se resuscriba en vez de quedarse
  esperando eventos que no van a llegar.

### Lo que no cubre

Transacciones privadas (`priv_*`), que el relay-signer en Go si maneja.

## Ejemplos

`examples/hardhat-storage/` despliega `Storage.sol` con Hardhat a traves del relayer, usando el
**`LacchainSigner` oficial de `@lacchain/gas-model-provider` sin modificar**: la misma libreria
que usan los dapps contra el relay-signer de LACChain, apuntada a este relayer.

```sh
cd examples/hardhat-storage && npm install && npm run compile
RELAYER_URL=http://localhost:3000 npm run deploy
```

### Prueba de carga de nonces

```sh
npm run test:nonces                      # 12 metatx simultaneas de un usuario
npm run test:nonces -- --n 16            # rafaga mas grande
npm run test:nonces -- --users 3 --n 8   # 3 usuarios en paralelo (los extra son wallets random)
npm run test:nonces -- --overflow        # pasarse a proposito de MAX_INFLIGHT_PER_USER
npm run test:nonces -- --rest            # por POST /relay en vez del proxy JSON-RPC
```

La rafaga entra por el **proxy JSON-RPC**, igual que un dapp: `eth_getTransactionCount` para el
nonce, `eth_sendRawTransaction` para mandar y poleo de `eth_getTransactionReceipt` para el
resultado. Ademas de los nonces, eso estresa las intercepciones del proxy (que el nonce sea el del
hub y no el de la cuenta, y que el receipt reescrito diga si la llamada del usuario se ejecuto).
Con `--rest` va por `POST /relay`, que responde recien con el receipt y muestra mas de cada metatx
(`simulated`, eventos).

Verifica que los nonces del hub queden consecutivos y sin repetidos, que el nonce minado coincida
con lo enviado, que solo se simule la primera de cada cadena (solo visible con `--rest`) y que no
queden metatx en vuelo. Medido en open-protestnet: **16/16 en 5 bloques** con un
usuario y **24/24 con 3 usuarios**. Pasado `MAX_INFLIGHT_PER_USER` la cola de la rafaga se cae con
`BAD_NONCE` (se llena la cola de espera), pero la cadena queda consistente: se pierden metatx, no se
corrompe el nonce.

Sirve tambien como deteccion del supuesto de una sola instancia: si dos relayers comparten la clave
del writer node, las tx se pisan en el nonce de la cuenta y la prueba lo marca con `RECEIPT_TIMEOUT`.

Como correrla, que verifica cada linea y como leer las fallas: [`examples/README.md`](examples/README.md).

## Usarlo como libreria

```ts
import { Relayer } from './src/relayer';
import { MetaTxClient } from './src/metatx';

const relayer = await Relayer.create();
const result = await relayer.relay(rawTx);       // -> { transactionHash, executed, errorCodeName, ... }

const client = new MetaTxClient(userPrivateKey, 'http://localhost:3000');
await client.call('0xContrato', 'store(uint256)', [42]);
```

## Requisitos del lado de la red

- **`RPC_URL` tiene que ser el JSON-RPC crudo de Besu.** El endpoint publico de un nodo lnet
  normalmente es el relay-signer oficial, que intercepta `eth_sendRawTransaction` esperando una
  metatx (chainId 0) y rechazaria las transacciones normales que manda este relayer.
- **`NODE_PRIVATE_KEY` tiene que ser la clave de un writer node** dado de alta en el hub
  (`addNode`) y con cupo de gas por bloque. Si no, el hub responde `NotEnoughGas`. Ademas tiene que
  estar en **AccountRules** (`addAccount`), si no el nodo rechaza la tx del relayer con
  `not authorized`: el relayer lo chequea al arrancar y lo avisa (ver
  [Permissioning de cuentas](#permissioning-de-cuentas)).
- El contrato destino tiene que heredar `BaseRelayRecipient` (o equivalente) con
  `trustedForwarder` = **proxy** del RelayHub, y usar `_msgSender()` en lugar de `msg.sender`.
- La metatx tiene que llegar con al menos **5 minutos** de `expiration` por delante
  (`MIN_EXPIRATION_SECONDS`, en `/info` como `minExpirationSeconds`). Menos que eso se rechaza con
  `EXPIRATION_TOO_LOW`: entre validar, simular, esperar el turno del nonce y minar pasan segundos,
  y una metatx que vence en el medio se pierde habiendo gastado una tx del writer node. El minimo se
  aplica con una tolerancia de **2 s** (`EXPIRATION_LATENCY_TOLERANCE_SECONDS`), porque quien firma
  `ahora + 300` llega con 299 o 298: se pierde la latencia del POST (hasta ~1 s) y hasta 1 s mas en
  el `floor` a segundos de cada lado. El piso real es la resta de los dos, y `/info` publica ambos
  (`minExpirationSeconds`, `expirationToleranceSeconds`).

### Direcciones conocidas

| red | proxy (trustedForwarder) | RelayHub | AccountRules |
|---|---|---|---|
| lnet mainnet | `0xEAA5420AF59305c5ecacCB38fcDe70198001d147` | `0x34B220Ef63dea567eDf6d540316B5a3f4831Cf6c` (resuelto con `getRelayHub()`) | `0x571d20db5f86FA53133D2c36A51a2ba731eC51B4` |
| open-protestnet / local | `0xa4B5eE2906090ce2cDbf5dfff944db26f397037D` | se resuelve con `getRelayHub()` | `0x23F99e888146FEE4A33aa330b7D1B2083de9F386` |

El `AccountIngress` esta en `0x0000000000000000000000000000000000008888` en las dos redes, y el
relayer resuelve el AccountRules igual que Besu: `getContractAddress("rules")`. La columna esta
como referencia, no hay que configurarla.

## Permissioning de cuentas

En LAC-NET la transaccion que llega a la cadena la firma el **writer node**, asi que el
permissioning que aplica el nodo es sobre el writer node y **no** sobre el usuario de la metatx.
Esa es la gracia del modelo de gas: una cuenta sin permisos ni saldo puede escribir. Verificado en
open-protestnet -- el writer node esta en `AccountRules` y el usuario de prueba no, y sus metatx se
relayan igual.

El relayer usa `AccountRules` para dos cosas distintas:

| | cuando | que hace |
|---|---|---|
| **writer node** | siempre, al arrancar | `accountPermitted(nodeAddress)`. Si da false lo avisa por log y lo expone en `/info` (`nodePermitted`). Sin esto el sintoma es un `SEND_FAILED` opaco con `not authorized` en la primera metatx que alguien mande |
| **usuario de la metatx** | solo con `ENFORCE_ACCOUNT_RULES=true` | `accountPermitted(from)` antes de reservar nonce y antes de simular. Si no esta, responde `SENDER_NOT_PERMITTED` sin gastar nada. Es lo que hace el relay-signer en Go |

La segunda va **apagada por defecto**, porque en el modelo de gas los usuarios no tienen por que
estar dados de alta: prenderla es decidir usar `AccountRules` como allowlist del relayer.

Detalles:

- La direccion se resuelve como lo hace Besu: `AccountIngress.getContractAddress("rules")`, con el
  ingress en `0x...8888`. `ACCOUNT_RULES_ADDRESS` la fija a mano.
- Si la cadena no expone `AccountRules` (devnet sin permissioning) el chequeo del node se saltea
  con un aviso. Con `ENFORCE_ACCOUNT_RULES=true` en cambio el arranque **aborta**: un allowlist que
  no se puede leer no se puede aplicar, y seguir seria dejar la puerta abierta creyendo lo contrario.
  Por la misma razon, si el `eth_call` falla en caliente la metatx se rechaza
  (`PERMISSIONING_UNAVAILABLE`) en vez de pasar de largo.
- El resultado se cachea `ACCOUNT_RULES_CACHE_MS` (30 s) para no pagar un `eth_call` por metatx. La
  contrapartida: dar de alta una cuenta tarda hasta eso en verse.

## Go vs Node: este relayer y el relay-signer oficial

El relay-signer oficial de LACChain esta en Go (`naas-gas-management`) y es un servicio de
produccion; este es una implementacion propia, minima, del mismo protocolo. Lo esencial:

| | Go (`gas-relay-signer`) | Node (`simple_relay`) |
|---|---|---|
| metatx por usuario por bloque | 1 (la segunda da `BAD NONCE`) | varias (medido: 6 en 2-3 bloques) |
| lecturas (`eth_call`, `eth_getLogs`, ...) | `method is not supported`: van a otro endpoint | passthrough crudo, un solo endpoint para el dapp |
| batches JSON-RPC | se reenvian sin inspeccionar | se parten y se rutean uno por uno |
| `eth_subscribe` / WebSocket | no | si, un upstream por cliente |
| pre-chequeo del hub | manda y se ve en el receipt | `eth_call` antes de gastar un bloque |
| receipt reescrito | `contractAddress` y `status: 0` con `revertReason` | lo mismo, mas `BadTransactionSent` -> `status: 0` |
| claves del writer node / auth | N claves en Postgres, resueltas por JWT | una sola clave en `.env`, sin auth |
| permissioning del sender (`AccountRules`) | siempre | opcional (`ENFORCE_ACCOUNT_RULES`), y chequea al writer node al arrancar |
| cupo de gas por bloque del node | lo lleva contado | lo deja al hub (la simulacion previa lo atrapa) |
| transacciones privadas (`priv_*`) | si | no |

Los dos primeros puntos son la razon practica de que exista este relayer; los tres ultimos son
lo que habria que sumarle para reemplazar al oficial en un despliegue multi-tenant.

El detalle largo -- por que la cola de nonces de Go no llega a encadenar, con las referencias al
codigo -- esta en [`COMPARACION-GO-NODE.md`](./COMPARACION-GO-NODE.md).

## Nonces y concurrencia

Hay **dos nonces** distintos y no tienen nada que ver entre si:

| | quien lo elige | como se maneja |
|---|---|---|
| nonce de la **metatx** | el usuario, y va **firmado** dentro del RLP | el relayer lo valida y lo reserva; no puede tocarlo sin invalidar la firma |
| nonce de la **cuenta del writer node** | ethers, al mandar `relayMetaTx` | serializado por un lock global alrededor del `send` |

### Varias metatx del mismo usuario en un mismo bloque

`getNonce` solo sube cuando la metatx se mina, asi que para encadenar no alcanza con leer la
cadena: el relayer lleva en memoria los nonces que ya reservo y todavia no se minaron
(`inflight`). Lo que hace que funcione es el orden: las tx de una EOA se ejecutan **en orden de
nonce**, y el lock del writer node asigna los nonces de la cuenta en el mismo orden en que se
reservan los del hub, con lo cual la metatx N se mina siempre antes que la N+1 aunque caigan en
el mismo bloque.

Sobre eso hay dos amortiguadores:

- **Buffer de reordenamiento** (`REORDER_WINDOW_MS`): sobre HTTP el orden de llegada no esta
  garantizado y el hub exige el nonce exacto. Una metatx adelantada espera a que se cierre el
  hueco en vez de morir con `BAD_NONCE`. La ventana mide **estancamiento, no espera total**: se
  renueva cada vez que la cadena avanza hacia ese nonce. Si midiera el total, una rafaga larga
  perderia la cola por reloj aunque todo estuviera funcionando (con ~1 s por envio, la metatx 12
  de una rafaga se cae de una ventana de 3 s mientras el hub va por la quinta).
- **Gracia antes de olvidar la cadena**: el tracker sobrevive un rato al ultimo receipt. Si se
  borrara al instante, en medio de una rafaga `nextNonce` caeria al nonce minado y un reintento
  resincronizaria a un nonce que otra metatx de la misma rafaga ya tomo.

Del lado cliente, `MetaTxClient` reparte los nonces con un cursor local (sin el, N `send()`
concurrentes firman todos el mismo valor) y reintenta ante `BAD_NONCE` resincronizando contra
`nextNonce`.

### Que rompe la cadena y que no

Un **revert del contrato destino no la rompe**: el hub igual incrementa el nonce y emite
`TransactionRelayed` con `executed: false`. Solo la rompe un rechazo a nivel hub
(`BadTransactionSent`), que es justo lo que atrapa la simulacion previa. Cuando pasa, el relayer
descarta los nonces reservados, lo loguea y resincroniza contra la cadena; las metatx que ya
salieron encadenadas detras se pierden y gastan una tx del writer node cada una. Por eso
`MAX_INFLIGHT_PER_USER` acota la rafaga.

Las metatx encadenadas van **sin simular** (`simulated: false` en la respuesta): el `eth_call`
corre contra `latest`, donde el nonce del hub todavia es el viejo, y devolveria `BadNonce` sin
mirar nada mas. Solo la primera de cada rafaga tiene pre-chequeo.

### Supuesto: una sola instancia

El tracker vive en memoria del proceso, asi que **este relayer tiene que ser el unico que use la
clave del writer node**. El diseno depende de eso: el mapping del hub es
`nonces[msg.sender][from]`, o sea que la casilla del usuario es de este writer node y nadie mas
la toca. Dos instancias compartiendo la clave se pisarian tanto en el nonce de la cuenta como en
el del hub. Si algun dia hace falta escalar horizontalmente, el tracker tiene que salir del
proceso (Redis o similar) o cada instancia usar su propio writer node.

Tras un reinicio el tracker arranca vacio y se resincroniza solo leyendo la cadena. El unico
hueco es reiniciar con metatx en vuelo: el nonce minado va atrasado respecto del txpool y alguna
puede salir con un nonce repetido. Se cura solo en el bloque siguiente.

## Detalles que cuestan iteraciones

- La ABI desplegada es `relayMetaTx(uint256 gasLimit, bytes signingData, uint8 v, bytes32 r, bytes32 s)`
  y devuelve `uint8` (`ErrorCode`), no `bool`. Verificado contra el bytecode on-chain
  (selector `0x1416862c`); circulan versiones viejas sin el `gasLimit` (`0xa04fb2ad`).
- `getNonce` usa `nonces[msg.sender][from]`: el `eth_call` **tiene que ir con `from` = writer node**,
  si no devuelve el casillero de otro nodo (siempre 0).
- `gasLimit` de la metatx = `len(data) * 105 + 300000 + gasLimit del usuario`, y ese mismo valor va
  como primer argumento **y** como gasLimit de la transaccion externa.
- El hub **no revierte** cuando algo esta mal: emite `BadTransactionSent` y devuelve un `ErrorCode`.
  Por eso el relayer simula con `eth_call` antes de enviar (`SIMULATE_BEFORE_SEND=true`) y decodifica
  los eventos del receipt: `executed: false` significa que el hub relayo pero el contrato destino revirtio.
- `Wallet.signTransaction` de ethers **no sirve** para firmar con `chainId 0` (valida la red);
  hay que firmar `tx.unsignedHash` con `wallet.signingKey` y serializar (es lo que hace `LacchainSigner`).
- Los receipts de Besu traen el campo `root` y ethers se queja: `LnetProvider` lo limpia y fuerza
  `confirmations = 1` para que `tx.wait()` no se cuelgue.
- **Deploys**: van por `deployMetaTx` (`to` vacio en el RLP). Al initcode se le agregan igual los
  64 bytes de `(nodeAddress, expiration)`; Solidity ignora los bytes de mas al decodificar los
  argumentos del constructor, asi que el deploy funciona sin tocar el contrato. La direccion sale
  del evento `ContractDeployed` (y la simulacion previa ya la anticipa).
- El `trustedForwarder` del contrato tiene que ser el **proxy**, no el hub: `BaseRelayRecipient`
  hace `staticcall` de `getRelayHub()` sobre el forwarder y el hub no tiene esa funcion, con lo cual
  el `abi.decode` revierte y el constructor se cae (el deploy devuelve direccion `0x0`).
- El hub no valida `expiration` ni `nodeAddress` (eso lo hace el permissioning del nodo);
  este relayer igual los valida para dar errores utiles antes de gastar un bloque. Ademas exige que
  a la `expiration` le queden `MIN_EXPIRATION_SECONDS` (5 min por defecto): aceptar una al filo es
  gastar una tx del writer node en una metatx que el nodo va a descartar. Ese piso se compara con
  `EXPIRATION_LATENCY_TOLERANCE_SECONDS` (2 s) de tolerancia: firmar `ahora + 300` y llegar con 299
  es lo normal, no un error del cliente.
- **Una metatx vencida traba la cola del writer node.** Verificado en protestnet: el nodo no la
  incluye en ningun bloque, pero la tx queda en el txpool ocupando el nonce de la cuenta, y todo lo
  que venga detras se queda esperando (`RECEIPT_TIMEOUT`). Se destraba mandando otra `relayMetaTx`
  valida con ese mismo nonce de cuenta. Es la razon de peso de `MIN_EXPIRATION_SECONDS`: el costo de
  aceptar una expiration al filo no es una metatx perdida, es la cola entera parada.
- El nodo solo le acepta al writer node transacciones con forma de `relayMetaTx`. Una transferencia
  comun desde esa cuenta -- por ejemplo para tapar un hueco de nonce -- se rechaza con
  `Sender account not authorized to send transactions`, aunque la cuenta este en `AccountRules`.
- El chequeo de permissioning util es `AccountRules.accountPermitted(address)`. El otro candidato,
  `transactionAllowed(sender, target, value, gasPrice, gasLimit, payload)`, devuelve **false** en
  mainnet y en protestnet incluso con el writer node permisionado y un target permisionado (parece
  exigir que la llamada venga del propio ingress): usarlo de pre-chequeo rechazaria todo.
- El hub **incrementa el nonce del usuario aunque el contrato destino revierta** (verificado
  on-chain: `executed: false` con el nonce igual avanzando). Es lo que permite encadenar metatx
  sin que un revert tumbe toda la rafaga.

## Autenticacion

`RELAY_API_SECRET` protege los tres caminos que gastan gas del writer node: `POST /relay`, el
JSON-RPC (`POST /`) y el WebSocket. `/info` y `/nonce/:address` quedan abiertos a proposito: el
cliente los necesita para armar la metatx.

```sh
curl -H "Authorization: Bearer $RELAY_API_SECRET" -X POST http://localhost:3000/relay \
  -H 'Content-Type: application/json' -d '{"rawTx":"0x..."}'
```

El WebSocket lo lleva en la query (`wss://host/?token=<secreto>`) porque el WebSocket del browser
no permite mandar cabeceras en el handshake. Sin la variable definida no se exige nada, que es lo
razonable en localhost.

## Despliegue en Vercel

`api/index.ts` exporta el `http.Server` (el patron que Vercel documenta para `ws` sobre Fluid
Compute), y `vercel.json` rutea todo el trafico ahi. Las rutas viven en `src/app.ts`, compartidas
con el arranque local.

```sh
vercel link --scope <equipo> --project node-relayer
vercel env add NODE_PRIVATE_KEY production      # y el resto de .env.example
vercel deploy                                   # --prod para produccion
```

> **Advertencia: el modelo serverless choca con el diseno de este relayer.**
> El tracker de nonces vive en memoria del proceso y asume una instancia unica (ver
> [Supuesto: una sola instancia](#supuesto-una-sola-instancia)). Fluid Compute agrupa
> invocaciones concurrentes en una instancia pero escala a varias bajo carga, y no hay garantia de
> instancia unica. Dos instancias con la misma clave de writer node se pisan el nonce y traban el
> txpool. Ademas el WebSocket se corta al llegar al `maxDuration` (300 s), asi que el cliente tiene
> que resuscribir sus `eth_subscribe`.
>
> Para produccion seria, el tracker tiene que salir del proceso (Redis) o el servicio tiene que
> correr como proceso persistente de instancia unica.

Si el nodo Besu filtra por IP de origen, hay que contemplar que la IP de egreso de las funciones
de Vercel es dinamica.


## Licencia

Apache License 2.0 -- ver [LICENSE](LICENSE).

```
Copyright 2026 LNet Networks

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
```
