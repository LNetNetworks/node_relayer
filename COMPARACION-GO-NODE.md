# Relayer en Go vs. relayer en Node

Comparacion entre el relay-signer en Go y este `simple_relay` en Node/TypeScript.

Del lado de Go hay **dos** variantes vivas, y hoy comparten el nucleo:

- **`gas-management`** (rama `develop`): el `gas-relay-signer` clasico de LACChain, una clave por
  writer node, leida de `WRITER_KEY`. Es la referencia de este documento.
- **`naas-gas-management`**: el fork multi-tenant de NAAS (N claves en Postgres resueltas por JWT).
  Ya **porto** el manejo de nonces del clasico (commit `1777467`, *"reemplazar la cola de nonces por
  el mecanismo anti-bloqueo del clasico"*), asi que todo lo que se dice aca sobre nonces vale para
  los dos. Las diferencias del fork son de multi-tenancy, no de modelo de gas.

El resumen esta en la tabla de abajo; el desarrollo largo es sobre nonces y concurrencia, que es
donde estan las diferencias de fondo. Despues va lo que el de Go hace y este todavia no, y los
riesgos abiertos de este.

> Alcance: el codigo Go lo lei, no lo ejecute. Los numeros medidos de la tabla de abajo son solo
> del relayer en Node, contra lnet testnet (open-protestnet).

> Revision: este documento se corrigio despues de releer las dos bases. La version anterior
> describia la **cola** de nonces de `service/servicio_nonce.go` (`Enqueue`/`Dequeue`), que **ya no
> existe** en ninguna de las dos variantes. Ver "Nota historica" al final.

## Resumen

| | Go (`gas-relay-signer`) | Node (`simple_relay`) |
|---|---|---|
| Rol en el despliegue | endpoint RPC del writer node; lo que no intercepta responde `method is not supported` (`controller/relayController.go:87`), asi que las lecturas necesitan un router delante | proxy JSON-RPC completo: un dapp apunta su provider aca y no cambia nada |
| Metodos | `eth_sendRawTransaction`, `eth_getTransactionReceipt`, `eth_getTransactionCount`, `relay_getMetaTxResult`, `priv_*` | los tres primeros, mas passthrough crudo del resto, batches partidos y `eth_subscribe` sobre WS |
| metatx por usuario por bloque | 1 (la segunda la rechaza el hub con `BadNonce`) | varias (medido: 6 en 2-3 bloques) |
| estado del nonce del hub | cache `senders` con TTL, **solo alimenta `eth_getTransactionCount(pending)`** | tracker `inflight` **autoritativo**: reserva, valida y encadena |
| validacion del nonce al enviar | **ninguna**: se manda y decide el hub on-chain | contra la reserva, que incluye lo en vuelo (`src/relayer.ts:758`) |
| llegada fuera de orden | `BadTransactionSent(BadNonce)`, con la tx ya gastada | buffer de reordenamiento con ventana (`src/relayer.ts:435`) |
| nonce de la cuenta del writer node | `PendingNonceAt` dentro de un `lock` global que serializa **todos** los relays | lock global alrededor del `send` unicamente |
| pre-chequeo del hub | no simula `relayMetaTx` | `eth_call` de la primera de cada rafaga |
| cupo de gas del nodo | **si**: contador local por bloque + `getGasLimit()` on-chain, reseteado por WS | **no** (solo lo expone en `/info`) |
| `nodeAddress` / `expiration` del sufijo | no los valida | los decodifica y valida (`ENFORCE_NODE_ADDRESS`, `MIN_EXPIRATION_SECONDS` con tolerancia) |
| firma pre-EIP155 | rechaza `v` fuera de {27,28} (`controller/processController.go:134`) | `validateMetaTxShape`: type 0, chainId 0, gasPrice 0, value 0, gasLimit > 0 |
| permissioning del usuario | `permissionsEnabled` + direccion fija en `config.toml` | `ENFORCE_ACCOUNT_RULES` (off), resuelto por `AccountIngress`, con cache y fail-closed |
| respuesta de `eth_sendRawTransaction` | hash al instante (semantica estandar) | hash al instante; `POST /relay` es la variante que espera el receipt y devuelve el resultado decodificado |
| reescritura del receipt | `contractAddress` del deploy y `status: 0` con `revertReason` | lo mismo, mas `BadTransactionSent` -> `status: 0` con `relayErrorCode` |
| resultado de la metatx | `relay_getMetaTxResult` | no existe: por JSON-RPC solo queda en el log (`relay.settled`) |
| transacciones privadas (`priv_*`) | si: proxy a Orion/Tessera y descuento del cupo de gas | no |
| claves del writer node / auth | una clave (`WRITER_KEY`); N claves en Postgres por JWT en NAAS | una sola clave en `.env`, **sin auth** |
| conexion al nodo | un cliente RPC por request (`Connect`/`Close`) | un `JsonRpcProvider` reusado |
| observabilidad | audit log a archivo, texto libre | una linea JSON por evento, con `reqId` (AsyncLocalStorage) e `instanceId` |

## 1. El nonce del usuario dentro del hub

Los dos resuelven bien el gotcha de fondo: el mapping del hub es `nonces[msg.sender][from]`, asi que
el `eth_call` de `getNonce` tiene que ir con `from` = writer node. Go lo hace en
`blockchain/client.go:179` (`CallOpts{From: nodeAddress}`), Node en `Relayer.getNonce`.

La diferencia esta en **que rol cumple** lo que el relayer recuerda.

### Go: la cache es una pista para el cliente, no una reserva

`service/relaySignerService.go:715-758` guarda, por sender, el **proximo** nonce a usar con su
timestamp:

```go
type nonceEntry struct {
    next      uint64
    updatedAt time.Time
}
```

- Se escribe en `incrementTransactionCount(from, nonce)`, despues de mandar la metatx
  (`relaySignerService.go:122`). No suma `+1` a ciegas: si la cache ya iba mas adelante, se conserva.
- Se lee **solo** desde `GetTransactionCount(from, isPending=true)` (`relaySignerService.go:321-329`).
- Expira por TTL (`nonceCacheTTL`, default 300 s) y se borra entera con `invalidateNonce(from)` al
  ver un `BadTransactionSent` en el receipt (`:194`) o en `relay_getMetaTxResult` (`:295`): esa
  metatx **no** consumio nonce en el hub, asi que el contador local quedo adelantado y no se corrige
  solo.

Lo importante es lo que **no** hace: `processRawTransaction` (`controller/processController.go`) no
mira el nonce en ningun momento. No hay reserva ni rechazo local: la metatx se manda y, si el nonce
no es el que el hub espera, el hub emite `BadTransactionSent(BadNonce)` con la tx del writer node ya
gastada. Encadenar dos metatx del mismo usuario antes de que la primera se mine no funciona, porque
la segunda llega con un nonce que el hub todavia no acepta.

El TTL y el `invalidateNonce` son la red anti-bloqueo: sin ellos una address quedaba trabada de forma
permanente tras un `BadNonce` concurrente (es el bug que arreglo el commit `3b833bf` del clasico).

### Node: reserva al enviar, valida contra lo en vuelo

El tracker (`inflight`, `src/relayer.ts:211`) guarda los nonces que este relayer ya reservo y
todavia no se minaron, y el chequeo del envio se hace contra eso, no contra la cadena:

```ts
const expectedNonce = entry ? entry.next : await this.getNonce(from);
if (expectedNonce !== BigInt(tx.nonce)) throw new RelayError(..., 'BAD_NONCE', { expected, got });
```

Es autoritativo porque la casilla `nonces[writerNode][from]` es de **este** relayer y nadie mas la
toca. Lo que hace que se pueda encadenar es un invariante de orden: las tx de una EOA se ejecutan
**en orden de nonce**, y el lock del writer node asigna los nonces de la cuenta en el mismo orden en
que se reservan los del hub. Por lo tanto la metatx N se mina siempre antes que la N+1, aunque las
dos caigan en el mismo bloque.

Sobre eso hay tres amortiguadores que el de Go no tiene:

- **Buffer de reordenamiento** (`awaitTurn`, `:435`). Sobre HTTP el orden de llegada no esta
  garantizado y el hub exige el nonce exacto. Una metatx que llega adelantada espera a que se cierre
  el hueco en vez de morir. La ventana mide **estancamiento**, no espera total: se renueva cada vez
  que la cadena avanza, para que una rafaga larga no pierda la cola por reloj estando todo sano.
- **Gracia antes de olvidar la cadena** (`releasePending`). El tracker sobrevive un rato al ultimo
  receipt: si se borrara al instante, en medio de una rafaga el `nextNonce` caeria al nonce minado y
  un reintento resincronizaria a un nonce que otra metatx de la misma rafaga ya tomo.
- **Cursor local en el cliente** (`MetaTxClient`, `src/metatx.ts:256`). Reparte los nonces de a uno;
  sin eso N `send()` concurrentes firman todos el mismo valor. Reintenta ante `BAD_NONCE`
  resincronizando contra `nextNonce`, que el relayer expone ya contando lo en vuelo.

Ninguno de los dos se puede quedar trabado, pero por caminos distintos: Go descarta la entrada por
TTL o al ver el `BadTransactionSent`; Node descarta la cadena entera ante cualquier fallo
(`forgetInflight`) y la vacia sola cuando no queda nada en vuelo. La identidad de la cadena es por
referencia, asi que un receipt atrasado de una cadena ya descartada no toca a la que la reemplazo.

## 2. El nonce de la cuenta del writer node

Es un nonce distinto y ninguno de los dos lo puede delegar en el cliente.

En Go, cada envio hace `ConfigTransaction(privateKey, gasLimit, true)`, que resuelve `PendingNonceAt`
(`blockchain/client.go:64`). No hay carrera porque `processRawTransaction` toma un `lock` global
(`controller/processController.go:164`) que cubre `VerifyGasLimit` **y** `SendMetatransaction`: los
relays se serializan de punta a punta, entre todos los usuarios. Es correcto y es caro — el throughput
del servicio queda atado a la latencia de un envio completo.

En Node el `send` va dentro de un lock global, que es la unica seccion critica: la validacion, la
simulacion y la espera del receipt quedan afuera, y la reserva del nonce del hub se serializa por
usuario (`userLocks`), no globalmente. Eso serializa la asignacion del nonce sin serializar el
throughput.

## 3. Pre-chequeo antes de gastar un bloque

El hub **no revierte** cuando algo esta mal: emite `BadTransactionSent` y devuelve un `ErrorCode`.

Go valida bastante antes de enviar -- permissioning del sender (`VerifySender`, `:403`), firma
pre-EIP155 y cupo de gas del nodo (`VerifyGasLimit`, `:365`) -- pero no simula `relayMetaTx`, asi que
un rechazo del hub se descubre despues, con la tx ya gastada. El cliente lo ve al pedir el receipt o
`relay_getMetaTxResult`.

Node simula la metatx con `eth_call` y traduce el `ErrorCode` a un error HTTP antes de mandar nada.
La contrapartida honesta: las metatx **encadenadas** van sin simular (`simulated: false` en la
respuesta), porque el `eth_call` corre contra `latest`, donde el nonce del hub todavia es el viejo, y
devolveria `BadNonce` sin mirar nada mas. Solo la primera de cada rafaga tiene pre-chequeo.

Los dos chequean `AccountRules`, pero al reves de default. Node siempre chequea al **writer node** al
arrancar (que es a quien el nodo le aplica el permissioning, y cuya falta se manifiesta como un
`not authorized` opaco), y el del **usuario** queda detras de `ENFORCE_ACCOUNT_RULES`, apagado,
porque en el modelo de gas los usuarios no tienen por que estar dados de alta. Ademas lo resuelve por
`AccountIngress.getContractAddress("rules")` en vez de una direccion fija en la config.

Lo que Node valida y Go no: el sufijo del modelo de gas. Go pasa el `data` entero sin mirarlo; Node
decodifica `(nodeAddress, expiration)` y rechaza temprano la metatx dirigida a otro nodo o con una
expiration vencida o al filo (con tolerancia por latencia, porque quien firma `ahora + 300` llega con
298 y exigir el valor exacto rechazaria justo al cliente que hizo lo correcto).

## 4. Semantica de la respuesta

Go devuelve el hash apenas la tx entra al txpool y el cliente polea `eth_getTransactionReceipt`, que
le llega con `contractAddress` completado y con `status: 0` mas el `revertReason` si la llamada del
usuario revirtio. Es la semantica estandar de `eth_sendRawTransaction` y no ata una conexion HTTP por
metatx. Ademas expone `relay_getMetaTxResult`, un metodo propio que devuelve el resultado de la
metatx sin tener que interpretar el receipt.

Node hace lo mismo en el camino JSON-RPC: `eth_sendRawTransaction` responde el hash sin esperar el
receipt (`Relayer.submitRelay`) y `eth_getTransactionReceipt` devuelve el receipt reescrito
(`Relayer.enrichReceipt`). Sobre lo de Go agrega un caso: cuando el hub **rechaza** la metatx
(`BadTransactionSent`) tampoco la ejecuto, asi que ese receipt tambien sale con `status: 0`, con
`relayErrorCode` / `relayErrorCodeName` para saber por que.

Aparte queda `POST /relay`, que si espera el receipt y devuelve el resultado ya decodificado
(`executed`, `errorCodeName`, `output`, `events`, direccion del deploy). Es mas comodo para un script
o un cliente simple, pero mantiene la conexion HTTP abierta hasta que la metatx se mina (con techo
`RECEIPT_TIMEOUT_MS`). Para volumen conviene el camino JSON-RPC.

No hay equivalente de `relay_getMetaTxResult`: por el camino JSON-RPC, el resultado final de una
metatx solo queda en el log (`relay.settled`). Es la brecha que se nota al portar scripts que lo usan
(por ejemplo `samples-error-tx-gas-model`, que lee los `ErrorCode` desde ahi).

## 5. Lo que el de Go hace y este todavia no

Este relayer es deliberadamente minimo. El de Go es un servicio de produccion y tiene varias cosas
que aca no estan:

- **Contabilidad del cupo de gas por bloque.** `ProcessNewBlocks` (`:584`) se suscribe por WebSocket
  a los bloques nuevos, resetea el contador local `GAS_LIMIT` en cada bloque y `VerifyGasLimit`
  rechaza la metatx que se pasaria del cupo del nodo (`getGasLimit()` on-chain). Con reconexion y
  backoff exponencial. **Es la unica cosa importante de Go que Node no cubre de ninguna forma**:
  aca solo la simulacion lo detecta, y solo para la primera de cada rafaga.
- **`relay_getMetaTxResult`**: resultado de la metatx como metodo JSON-RPC propio.
- **Transacciones privadas** (`priv_*`): las reenvia a Orion/Tessera y descuenta el gas usado.
- **Multiples claves de writer node** (solo NAAS): `dao.GetKeyByID(keyID)`, con almacenamiento de
  claves en Postgres.
- **Autenticacion** (solo NAAS): JWT contra Keycloak (`middlewares/jwtMiddleware.go`).
- **Audit log** separado.

## 6. Que gestiona mejor el de Node

1. **Varias metatx por usuario en el mismo bloque.** Es la diferencia principal: Go no reserva
   nonces, asi que encadenar no funciona.
2. **Proxy RPC completo.** El handler de Go solo acepta los cuatro metodos que intercepta mas
   `priv_*`; cualquier otro cae en el `default` y responde `method is not supported`, asi que las
   lecturas tienen que ir a otro endpoint o a un router delante (en NAAS lo hace el `rpc-router`).
   Aca las lecturas pasan crudas y el dapp usa un solo endpoint. Ademas los batches se parten
   (ethers v6 batchea por defecto, y sin partirlos una escritura se colaria al nodo), y hay
   `eth_subscribe` sobre WebSocket con un upstream por cliente.
3. **Throughput.** Go serializa todos los relays con un lock global; aca solo el `send`.
4. **Tolera la llegada fuera de orden** en vez de gastar una tx del writer node para descubrirla.
5. **Pre-chequeo con simulacion** antes de gastar un bloque.
6. **Valida el sufijo del modelo de gas** (`nodeAddress`, `expiration`) y resuelve `AccountRules`
   por `AccountIngress` en vez de una direccion fija.
7. **Una sola conexion RPC** reusada, en vez de abrir y cerrar un cliente por request.
8. **Log estructurado**: una linea JSON por evento, con `reqId` propagado por AsyncLocalStorage e
   `instanceId` por proceso, filtrable por `event`/`code`.

## 7. Riesgos abiertos de este relayer

Son limitaciones conocidas, no bugs latentes, pero conviene tenerlas escritas:

- **Serverless contra estado en memoria.** El repo esta preparado para Vercel (`vercel.json`,
  `api/index.ts`) pero `inflight` y el lock del nonce viven en el proceso. Dos instancias con la
  misma clave se pisan en el nonce del hub **y** en el de la cuenta del writer node. Por eso
  `instanceId` va en cada linea de log: dos `instanceId` distintos relayando para el mismo `from` es
  el escenario que rompe la cadena. En Besu < 23.10.2 con gasPrice 0 el reemplazo por nonce no
  funciona, asi que una colision deja la tx atascada hasta que se rellene el nonce.
- **Sin control del cupo de gas del nodo** (ver punto 5). Una rafaga encadenada, que no se simula,
  puede pasarse del cupo y quemar N tx del writer node con `MaxBlockGasLimit`.
- **Costo de una cadena rota.** Cuando el hub rechaza la metatx k, las k+1..k+n ya salieron: cada una
  gasta una tx del writer node. `MAX_INFLIGHT_PER_USER` (16) acota el dano pero no lo evita.
- **Open relay.** `/relay` y el JSON-RPC no autentican: cualquiera que alcance la URL consume el cupo
  de gas del writer node.

## Supuesto de diseno

El tracker de Node vive en memoria del proceso, asi que **este relayer tiene que ser el unico que use
la clave del writer node**. Es un supuesto valido en el despliegue actual (una sola instancia), y el
de Go tiene la misma restriccion por el mismo motivo: su cache tambien es local al proceso. Para
escalar horizontalmente habria que sacar el estado del proceso o darle a cada instancia su propio
writer node.

## Nota historica: la cola de nonces

La primera version de este documento describia una **cola FIFO** por sender en
`naas-gas-management/service/servicio_nonce.go`, que repartia `ultimo + 1` en cada consulta de nonce
pending y validaba el envio contra el nonce **minado**, y le atribuia dos defectos: la cola se
llenaba sin drenarse (dejando al sender bloqueado hasta reiniciar el proceso) y tenia una carrera de
datos porque el `Dequeue()` corria sin tomar el lock.

Ese codigo ya no existe. NAAS lo reemplazo por la cache con TTL del clasico en el commit `1777467`
("reemplazar la cola de nonces por el mecanismo anti-bloqueo del clasico"), y el clasico nunca la
tuvo. Las criticas de arriba ya no aplican a ninguna de las dos variantes: hoy el problema de Go no
es que se trabe, es que **no reserva nonces en absoluto**, y por eso no puede encadenar.
