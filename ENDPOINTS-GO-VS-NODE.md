# Endpoints: relay-signer en Go vs. `simple_relay` en Node

Comparacion **de la superficie HTTP/RPC** de los dos relayers: que rutas expone cada uno, que
metodos atiende, que devuelve y en que se comportan distinto. El contraste de fondo (nonces,
concurrencia, cupo de gas) esta en [`COMPARACION-GO-NODE.md`](COMPARACION-GO-NODE.md); este
documento es el que sirve para **migrar un cliente** de uno al otro o para saber a que endpoint
pegarle.

- **Go**: `gas-management` (`gas-relay-signer`), rama `develop`. Rutas en `main.go:78`, despacho en
  `controller/relayController.go:35`.
- **Node**: este repo. Rutas en `src/app.ts`, ruteo JSON-RPC en `src/rpc-proxy.ts`, WS en
  `src/ws-proxy.ts`.

> El codigo Go se leyo, no se ejecuto.

## 0. Resumen en una tabla

| | Go (`gas-relay-signer`) | Node (`simple_relay`) |
|---|---|---|
| Puerto por defecto | `9001` (`config.toml`, `[application].port`) | `3001` (`PORT`) |
| Rutas HTTP | `/`, `/info`, `/nonce/{address}`, `/relay`, y `/dashboard` + `/dashboard/stream` con el monitor encendido; `/` sigue siendo el catch-all | `/`, `/info`, `/nonce/:address`, `/relay`, `/dashboard`, `/dashboard/stream` |
| Protocolo | JSON-RPC unicamente | JSON-RPC + REST + SSE + WebSocket |
| Batch JSON-RPC | **no** (decodifica un objeto; un array no parsea) | si, y lo **parte**: escrituras al relayer, lecturas al nodo |
| WebSocket | no | si, mismo puerto, con `eth_subscribe` / `eth_unsubscribe` |
| CORS | si, con los origenes de `[cors].allowedOrigins`; vacio -el default- no manda ninguna cabecera | si (`CORS_ORIGIN`, default `*`) |
| Auth | no (NAAS agrega JWT en su fork) | no |
| Metodos no interceptados | `method is not supported` | passthrough crudo al nodo |
| Codigo de error JSON-RPC | `-32000` por defecto; el resto los pone el error tipado | `-32000` para `RelayError`; `-32600/-32601/-32602/-32603` segun el caso |
| HTTP status | siempre `200` (incluso en error) | `200`, `204` (batch de notificaciones), `400`, `500`, `503` |

## 1. Rutas

### Go: `POST /` y nada mas

`mux.HandleFunc("/", relayController.SignTransaction)` registra un **catch-all**: `/`, `/rpc`,
`/loquesea` entran todas al mismo handler. No hay health check, ni metricas, ni `/info`.

El despacho es por el campo `method` del JSON-RPC y se hace por **sufijo/prefijo**, no por igualdad
(`rpc/json.go:93-125`), asi que el namespace da igual: `eth_sendRawTransaction`,
`lac_sendRawTransaction` o `x_sendRawTransaction` entran todos por la misma rama.

| Condicion | Rama |
|---|---|
| prefijo `priv_` | reverse-proxy crudo al nodo (Orion/Tessera) |
| prefijo `eea_` | descuenta el cupo de gas y hace reverse-proxy al nodo |
| sufijo `_sendRawTransaction` | **relaya** la metatx |
| sufijo `_getTransactionReceipt` | receipt reescrito |
| sufijo `_getTransactionCount` | nonce de metatx |
| sufijo `_getMetaTxResult` | resultado decodificado de la metatx |
| cualquier otro | error `method is not supported` |

Dos consecuencias practicas:

- **Las lecturas no pasan.** `eth_call`, `eth_blockNumber`, `eth_chainId` responden
  `method is not supported`. Por eso en el writer hay un nginx/openresty en el **puerto 80** que
  enruta por metodo: los cinco de arriba al relay-signer `:9001` y el resto a besu `:4545`. En NAAS
  ese papel lo hace el `rpc-router`.
- `IsGetBlockByNumber` y `IsSubscribe`/`IsUnsubscribe` existen en `rpc/json.go` pero **el controller
  no los usa**: `eth_getBlockByNumber` y `eth_subscribe` caen en el `default`.

### Node: seis rutas

| Ruta | Metodo | Para que |
|---|---|---|
| `/` | POST | JSON-RPC (drop-in del de Go, mas passthrough y batch) |
| `/info` | GET | estado del relayer y parametros del gas model |
| `/nonce/:address` | GET | nonce de metatx del usuario (+ el que hay que firmar ahora) |
| `/relay` | POST | REST: manda una metatx firmada y **espera** el resultado decodificado |
| `/dashboard` | GET | monitor en vivo (HTML) |
| `/dashboard/stream` | GET | eventos SSE del monitor |
| `ws://…` | — | mismo puerto: JSON-RPC + `eth_subscribe`/`eth_unsubscribe` |

Solo `/` tiene equivalente en Go. `/relay` **no es** el endpoint RPC: es azucar REST para probar a
mano y para clientes que prefieren esperar el resultado en la misma llamada.

## 2. Metodo por metodo (`POST /`)

### `eth_sendRawTransaction`

| | Go | Node |
|---|---|---|
| Params | `[rawTx]` (hex con `0x`) | igual |
| Respuesta | hash de la tx del nodo al hub | igual |
| Espera al receipt | no | no (para eso esta `POST /relay`) |
| Valida la firma | `v ∈ {27,28}`, si no `transaction must be signed pre-EIP155 (chainId=0, v=27 or 28)` (`processController.go:134`) | `validateMetaTxShape`: type 0, chainId 0, gasPrice 0, value 0, gasLimit > 0 |
| Valida el sufijo del gas model | los decodifica y valida, detras de `validation.enforceNodeAddress` y `validation.enforceExpiration`, apagados por defecto | los decodifica y valida (`ENFORCE_NODE_ADDRESS`, `MIN_EXPIRATION_SECONDS` + tolerancia), encendidos por defecto |
| Valida el nonce | no: lo decide el hub on-chain | contra la reserva, incluyendo lo en vuelo |
| Cupo de gas | si: `VerifyGasLimit` contra el cupo del nodo, con `metaTxGasLimit = len(data)*105 + 300000 + gasLimit` | no (solo lo informa `/info`) |
| Permissioning del sender | si `permissionsEnabled`: `account sender is not permitted to send transactions` | si `ENFORCE_ACCOUNT_RULES`: `SENDER_NOT_PERMITTED` |
| Pre-chequeo | no simula | `eth_call` de la primera de cada rafaga |
| Concurrencia | lock global: serializa **todos** los relays | lock solo alrededor del `send` |

### `eth_getTransactionCount`

La diferencia con mas potencial de romper un cliente al migrar:

| | Go | Node |
|---|---|---|
| `params[1] = "latest"` | nonce on-chain del hub | nonce on-chain del hub |
| `params[1] = "pending"` | tracker de lo en vuelo si hay cadena viva; si no, on-chain. Con `reorder.autoNonce` reparte el numero | `nextNonce`: on-chain + lo en vuelo, y con `AUTO_NONCE` **reserva** el numero |
| **sin `params[1]`** | **se comporta como `latest`** (`processController.go:71`) | **se comporta como pending** (reserva) |
| Otro valor (`"earliest"`, un numero de bloque) | error `parameter not defined, only pending or latest are allowed` | se trata como pending |
| Sensible a mayusculas | no (`strings.ToUpper`) | si (`=== 'latest'`) |

### `eth_getTransactionReceipt`

Los dos reescriben el receipt (`status: 0` + `revertReason` cuando la metatx fallo, `contractAddress`
en deploys). Node ademas agrega `relayErrorCode` cuando hubo `BadTransactionSent`. En Go el hash se
toma como `params[0][2:]` sin validar: un hash sin `0x` sale mal silenciosamente.

### `*_getMetaTxResult`

**Solo en Go.** Devuelve
`{transactionHash, mined, success, executed, errorCode, revertReason, deployedAddress}`.
En Node no existe: por JSON-RPC el resultado solo queda en el log (`relay.settled`); si lo necesitas
en la respuesta, usa `POST /relay`, que trae los mismos datos y mas.

### `eth_sendTransaction`, `eth_sign`, `eth_signTransaction`

Node los rechaza explicitamente con `-32601` y un mensaje que dice que firmes en el cliente. Go cae
en el `default` con `method is not supported`. Ninguno de los dos custodia la clave del usuario.

### `eth_accounts`, `eth_requestAccounts`

Node devuelve `[]` (para que un dapp no se cuelgue). Go: `method is not supported`.

### `priv_*` / `eea_sendRawTransaction`

**Solo en Go**: reverse-proxy a Orion/Tessera, y en el caso de `eea_` descontando el gas usado.
Node no las trata de forma especial (caen en passthrough, sin descuento de cupo).

### Todo lo demas

Go: `method is not supported`. Node: passthrough crudo al nodo, incluido dentro de un batch.

## 3. Las rutas que solo existen en Node

### `GET /info`

```bash
curl -s http://localhost:3001/info
```

`nodeAddress`, `relayHubAddress` + `relayHubSource`, `relayHubProxyAddress`, `chainId`, `rpcUrl`,
`nodeBalance`, `currentGasLimit`, `accountRulesAddress` + `accountRulesSource`, `nodePermitted`,
`enforceAccountRules`, `minExpirationSeconds`, `expirationToleranceSeconds`, `maxInflightPerUser`,
`reorderWindowMs`, `autoNonce`, `autoNonceTicketMs`.

De aca sale el `relayHubProxyAddress` que va como `trustedForwarder` de los contratos y el
`minExpirationSeconds` que debe respetar la firma. Go informa lo mismo, y `accountRulesSource`
distingue igual que aca una direccion configurada de una que publica el registro de permisos de la
red; la diferencia que queda es `relayHubSource`, que en Go siempre sale del proxy.

### `GET /nonce/:address`

```bash
curl -s http://localhost:3001/nonce/0xAbC…
curl -s "http://localhost:3001/nonce/0xAbC…?peek=true"   # mira sin reservar
```

`{ address, nonce, nonceHex, nextNonce, nextNonceHex, pending }`. Con `AUTO_NONCE` pedirlo
**reserva** el numero; `?peek=true` (o `?peek=1`) evita meterse en la cola de otro cliente.
Equivale a `eth_getTransactionCount`, pero devuelve los dos nonces a la vez y cuantas metatx hay en
vuelo.

### `POST /relay`

```bash
curl -s -X POST http://localhost:3001/relay -H 'content-type: application/json' \
  -d '{"rawTx":"0xf8aa…"}'          # tambien acepta la clave "signedTransaction"
```

Espera al receipt y devuelve
`{transactionHash, isDeploy, deployedAddress, blockNumber, gasUsed, errorCode, errorCodeName,
simulated, executed, from, to, nonce, metaTxGasLimit, output, events}`.
En un deploy la direccion sale del evento `ContractDeployed`, no del receipt.

Error `400` con `{error, code, details}` y `code` en: `BAD_RAW_TX`, `BAD_META_TX`, `BAD_NONCE`,
`WRONG_NODE_ADDRESS`, `EXPIRED`, `EXPIRATION_TOO_LOW`, `SENDER_NOT_PERMITTED`,
`PERMISSIONING_UNAVAILABLE`, `TOO_MANY_INFLIGHT`, `SIMULATION_FAILED`, `SEND_FAILED`, `NO_RECEIPT`,
`RECEIPT_TIMEOUT`, `RELAY_ERROR`.

En Go el equivalente es de dos pasos: `eth_sendRawTransaction` y despues pollear
`*_getMetaTxResult` o el receipt.

### `GET /dashboard` y `GET /dashboard/stream`

Monitor en vivo (HTML + SSE), activo salvo `DASHBOARD=false`. El stream admite 8 clientes (si no,
`503`), manda heartbeat cada 15 s y se reanuda con `?after=<seq>` o `last-event-id`. Solo lee el bus
de eventos: no toca el camino de la metatx. Go tiene lo mismo desde `03-add-relay-dashboard`
-misma pagina, mismo vocabulario de eventos, mismo techo de 8 clientes-, detras de
`[dashboard].enabled`, apagado por defecto.

### WebSocket

Mismo puerto que el HTTP. Mismo ruteo de metodos y ademas `eth_subscribe`/`eth_unsubscribe` contra
el WS del nodo (`WS_URL`, o derivado del `RPC_URL` sumando 1 al puerto). Go usa WebSocket solo
**hacia el nodo** (para resetear el cupo de gas por bloque), nunca de cara al cliente.

## 4. Errores: forma de la respuesta

**Go** — siempre HTTP `200`; el error va en el cuerpo JSON-RPC, con `-32000` por defecto y el codigo
del error tipado cuando lo hay (`rpc/errors.go`, `-32602` params, `-32603` interno, `-32610` proxy
del RelayHub…):

```json
{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"transaction gas limit exceeds block gas limit"}}
```

Casos que responden **cuerpo vacio con 200**: body que no parsea, o un batch (array), porque el
decoder espera un objeto y el handler hace `return` sin escribir.

**Node** — en `POST /` tambien JSON-RPC sobre `200`, con `-32000` para `RelayError` y el mensaje
`CODE: descripcion` mas el detalle en `data`. En las rutas REST el error va con status HTTP
(`400` body invalido o metatx rechazada, `500` inesperado) y forma `{error, code, details}`.

## 5. Migrar un cliente

**De Go a Node**: apunta el `LacchainProvider` al nuevo host y listo, salvo tres cosas:

1. Si usas `*_getMetaTxResult`, no existe: cambia a `POST /relay` (o lee el receipt enriquecido).
2. Si llamas `eth_getTransactionCount` **sin** el segundo parametro, en Go te daba `latest` y aca te
   da un nonce reservado: pasa `"latest"` explicito si querias lo minado.
3. Si dependes de `priv_*`/`eea_*`, no estan.

**De Node a Go**: pon un router delante (nginx por metodo) o pierdes todas las lecturas; olvidate de
batches, WebSocket de cara al cliente, CORS y de encadenar varias metatx del mismo usuario en un
bloque.

**Comun a los dos**: el cliente firma igual (metatx pre-EIP155 con el sufijo de 64 bytes), el nonce
de metatx se pide igual y `eth_sendRawTransaction` devuelve el hash en ambos.
