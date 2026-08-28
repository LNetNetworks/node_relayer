# Relayer en Go vs. relayer en Node

Comparacion entre el relay-signer en Go (`naas-gas-management`, el `gas-relay-signer` de LACChain
con el agregado propio de `service/servicio_nonce.go`) y este `simple_relay` en Node/TypeScript.

El resumen esta en la tabla de abajo; el desarrollo largo es sobre nonces y concurrencia, que es
donde estan las diferencias de fondo. Al final, lo que el de Go hace y este todavia no.

> Alcance: el codigo Go lo lei, no lo ejecute. Los numeros medidos de la tabla de abajo son solo
> del relayer en Node, contra lnet testnet (open-protestnet).

## Resumen

| | Go (`gas-relay-signer`) | Node (`simple_relay`) |
|---|---|---|
| metatx por usuario por bloque | 1 (la segunda da `BAD NONCE`) | varias (medido: 6 en 2-3 bloques) |
| reserva del nonce del hub | al **leer** el nonce, en una cola FIFO por sender | al **enviar**, en un tracker por usuario |
| validacion del nonce al enviar | contra la cadena, ignorando la reserva | contra la reserva, que incluye lo en vuelo |
| llegada fuera de orden | `BAD NONCE` | buffer de reordenamiento con ventana |
| nonce de la cuenta del writer node | `PendingNonceAt` sin serializar | lock global alrededor del `send` |
| pre-chequeo del hub | no simula `relayMetaTx` | `eth_call` de la primera de cada rafaga |
| respuesta de `eth_sendRawTransaction` | hash al instante (semantica estandar) | hash al instante; `POST /relay` es la variante que espera el receipt y devuelve el resultado decodificado |
| reescritura del receipt | `contractAddress` del deploy y `status: 0` con `revertReason` | lo mismo, mas `BadTransactionSent` -> `status: 0` con `relayErrorCode` |
| transacciones privadas (`priv_*`) | si: proxy a Orion/Tessera y descuento del cupo de gas | no |
| claves del writer node / auth | N claves en Postgres, resueltas por JWT | una sola clave en `.env`, sin auth |
| conexion al nodo | un cliente RPC por request (`Connect`/`Close`) | un `JsonRpcProvider` reusado |
| lecturas (`eth_call`, `eth_getLogs`, ...) | **`method is not supported`** (HTTP 400) | passthrough crudo al nodo |
| batches JSON-RPC | se reenvian sin inspeccionar | se parten y se rutean uno por uno |
| `eth_subscribe` / WebSocket | no (usa WS solo para su propio contador de gas) | si, un upstream por cliente |

## 1. El nonce del usuario dentro del hub

Los dos resuelven bien el gotcha de fondo: el mapping del hub es `nonces[msg.sender][from]`, asi que
el `eth_call` de `getNonce` tiene que ir con `from` = writer node. Go lo hace en
`blockchain/client.go:191` (`CallOpts{From: nodeAddress}`), Node en `Relayer.getNonce`.

La diferencia esta en **cuando** se reserva el nonce y **contra que** se valida.

### Go: reserva al leer, valida contra la cadena

`GetTransactionCount(from, isPending=true)` lee el nonce de la cadena y, si la cola del sender no
esta vacia, devuelve `ultimo + 1` y encola ese valor (`service/relaySignerService.go:260-274`):

```go
if q := service.senders[from]; q.Len() > 0 {
    snapshot := q.Snapshot()
    last := snapshot[len(snapshot)-1]
    nonce = new(big.Int).Add(last, big.NewInt(1))
}
service.senders[from].Enqueue(nonce)
```

La intencion es clara y es la correcta: repartir nonces consecutivos para poder encadenar. El
problema es que el camino de envio no usa esa reserva (`service/relaySignerService.go:111`):

```go
nonceLatest, err = client.GetTransactionCount(relayHub, address, nodeAddress) // <- la CADENA
if nonceLatest.Cmp(big.NewInt(int64(nonce))) == 0 {
    // ... enviar
} else {
    return result.ErrorResponse(errors.New("BAD NONCE", -32000))
}
```

`nonceLatest` es el nonce minado. El nonce del hub solo sube cuando la metatx entra en un bloque,
asi que el `N+1` que la cola acaba de repartir **lo rechaza el propio relayer**, salvo que la
primera ya se haya minado en el medio. En la practica: una metatx por usuario por bloque, y la
segunda no espera, falla.

Hay dos efectos secundarios:

- **La cola se llena y no se vacia.** El unico `Dequeue()` esta en el camino de exito
  (`service/relaySignerService.go:125-126`). Un envio que falla no drena nada, y el `Enqueue`
  corre en **toda** consulta de nonce pending, se mande la metatx o no. Cada consulta sin envio, y
  cada envio fallido, deja un elemento: `ultimo + 1` queda por encima de la cadena para siempre y
  ese sender no puede volver a mandar hasta reiniciar el proceso.
- **Carrera de datos.** `GetTransactionCount` toca el mapa bajo `service.mu`
  (`service/relaySignerService.go:226`), pero `SendMetatransaction` hace `Dequeue()` sobre el mismo
  mapa **sin tomar el lock** (linea 125). El propio `servicio_nonce.go` lo avisa en su comentario de
  cabecera: *"no es thread-safe por si sola; usa locks externos"*.

### Node: reserva al enviar, valida contra lo en vuelo

El tracker (`inflight`) guarda los nonces que este relayer ya reservo y todavia no se minaron, y el
chequeo del envio se hace contra eso, no contra la cadena:

```ts
const expectedNonce = entry ? entry.next : await this.getNonce(from);
if (expectedNonce !== BigInt(tx.nonce)) throw new RelayError(..., 'BAD_NONCE', { expected, got });
```

Lo que hace que se pueda encadenar es un invariante de orden: las tx de una EOA se ejecutan **en
orden de nonce**, y el lock del writer node asigna los nonces de la cuenta en el mismo orden en que
se reservan los del hub. Por lo tanto la metatx N se mina siempre antes que la N+1, aunque las dos
caigan en el mismo bloque.

Sobre eso hay tres amortiguadores que el de Go no tiene:

- **Buffer de reordenamiento.** Sobre HTTP el orden de llegada no esta garantizado y el hub exige el
  nonce exacto. Una metatx que llega adelantada espera a que se cierre el hueco en vez de morir.
- **Gracia antes de olvidar la cadena.** El tracker sobrevive un rato al ultimo receipt: si se
  borrara al instante, en medio de una rafaga el `nextNonce` caeria al nonce minado y un reintento
  resincronizaria a un nonce que otra metatx de la misma rafaga ya tomo.
- **Cursor local en el cliente.** `MetaTxClient` reparte los nonces de a uno; sin eso N `send()`
  concurrentes firman todos el mismo valor. Reintenta ante `BAD_NONCE` resincronizando contra
  `nextNonce`, que el relayer expone ya contando lo en vuelo.

A diferencia de la cola de Go, el tracker **no se puede quedar trabado**: se descarta ante cualquier
fallo y se vacia solo cuando no queda nada en vuelo, resincronizando contra la cadena.

## 2. El nonce de la cuenta del writer node

Es un nonce distinto y ninguno de los dos lo puede delegar en el cliente.

En Go, cada envio hace `ConfigTransaction(privateKey, gasLimit, true)`
(`service/relaySignerService.go:112`), que resuelve `PendingNonceAt` (`blockchain/client.go:64`) sin
ninguna serializacion. Dos requests concurrentes leen el mismo nonce pendiente y arman dos tx con el
mismo nonce de cuenta: una reemplaza a la otra en el txpool. El `sync.Mutex` global del paquete
(`relaySignerService.go:42`) se usa solo para el contador de gas, no para esto.

En Node el `send` va dentro de un lock global, que es la unica seccion critica: la validacion, la
simulacion y la espera del receipt quedan afuera. Eso serializa la asignacion del nonce sin
serializar el throughput.

## 3. Pre-chequeo antes de gastar un bloque

El hub **no revierte** cuando algo esta mal: emite `BadTransactionSent` y devuelve un `ErrorCode`.

Go valida bastante antes de enviar -- permissioning del sender (`AccountPermitted`) y cupo de gas del
nodo (`VerifyGasLimit`) -- pero no simula `relayMetaTx`, asi que un rechazo del hub se descubre
despues, con la tx ya gastada. El cliente lo ve al pedir el receipt.

Node tiene el mismo chequeo de `AccountRules` pero al reves de default: siempre chequea al **writer
node** al arrancar (que es a quien el nodo le aplica el permissioning, y cuya falta se manifiesta
como un `not authorized` opaco), y el del **usuario** queda detras de `ENFORCE_ACCOUNT_RULES`,
apagado, porque en el modelo de gas los usuarios no tienen por que estar dados de alta.

Node simula la metatx con `eth_call` y traduce el `ErrorCode` a un error HTTP antes de mandar nada.
La contrapartida honesta: las metatx **encadenadas** van sin simular (`simulated: false` en la
respuesta), porque el `eth_call` corre contra `latest`, donde el nonce del hub todavia es el viejo, y
devolveria `BadNonce` sin mirar nada mas. Solo la primera de cada rafaga tiene pre-chequeo.

## 4. Semantica de la respuesta

Go devuelve el hash apenas la tx entra al txpool y el cliente polea `eth_getTransactionReceipt`, que
le llega con `contractAddress` completado y con `status: 0` mas el `revertReason` si la llamada del
usuario revirtio. Es la semantica estandar de `eth_sendRawTransaction` y no ata una conexion HTTP por
metatx.

Node hace lo mismo en el camino JSON-RPC: `eth_sendRawTransaction` responde el hash sin esperar el
receipt (`Relayer.submitRelay`) y `eth_getTransactionReceipt` devuelve el receipt reescrito
(`Relayer.enrichReceipt`). Sobre lo de Go agrega un caso: cuando el hub **rechaza** la metatx
(`BadTransactionSent`) tampoco la ejecuto, asi que ese receipt tambien sale con `status: 0`, con
`relayErrorCode` / `relayErrorCodeName` para saber por que.

Aparte queda `POST /relay`, que si espera el receipt y devuelve el resultado ya decodificado
(`executed`, `errorCodeName`, `output`, `events`, direccion del deploy). Es mas comodo para un script
o un cliente simple, pero mantiene la conexion HTTP abierta hasta que la metatx se mina (con techo
`RECEIPT_TIMEOUT_MS`). Para volumen conviene el camino JSON-RPC.

## 5. Lo que el de Go hace y este todavia no

Este relayer es deliberadamente minimo. El de Go es un servicio de produccion y tiene varias cosas
que aca no estan:

- **Multiples claves de writer node** (`dao.GetKeyByID(keyID)`), con almacenamiento de claves.
- **Autenticacion** por JWT (`middlewares/jwtMiddleware.go`).
- **Contabilidad del cupo de gas por bloque**: se suscribe por WebSocket a los bloques nuevos
  (`ProcessNewBlocks`) y lleva el gas consumido para no pasarse del cupo del nodo.
- **Transacciones privadas** (`priv_*`): las reenvia a Orion/Tessera y descuenta el gas usado.
- **Audit log** separado.

## 6. Que gestiona mejor el de Node

1. **Varias metatx por usuario en el mismo bloque.** Es la diferencia principal: en Go la reserva
   existe pero el camino de envio la ignora, asi que no llega a funcionar.
2. **Proxy RPC completo.** El handler de Go solo acepta `eth_sendRawTransaction`,
   `eth_getTransactionReceipt`, `eth_getTransactionCount` y `priv_*`; cualquier otro metodo cae en
   el `default` y responde `method is not supported`, asi que las lecturas tienen que ir a otro
   endpoint. Aca las lecturas pasan crudas y el dapp usa un solo endpoint. Ademas los batches se
   parten (ethers v6 batchea por defecto, y sin partirlos una escritura se colaria al nodo).
3. **El nonce de la cuenta del writer node**, serializado en vez de leido en paralelo.
4. **No se traba.** La cola de Go crece con cada consulta y cada fallo, y no tiene forma de
   resincronizar; el tracker se descarta y relee la cadena solo.
5. **Sin carrera de datos** sobre la estructura de nonces.
6. **Tolera la llegada fuera de orden** en vez de rechazarla.
7. **Pre-chequeo con simulacion** antes de gastar un bloque.
8. **Una sola conexion RPC** reusada, en vez de abrir y cerrar un cliente por request.

Donde el de Go sigue adelante: todo el punto 5 (multiples claves, auth, contabilidad del cupo de
gas, `priv_*`, audit log). La diferencia de semantica del punto 4 ya no
existe: el camino JSON-RPC de Node tambien responde el hash sin esperar el receipt.

## Supuesto de diseno

El tracker de Node vive en memoria del proceso, asi que **este relayer tiene que ser el unico que use
la clave del writer node**. Es un supuesto valido en el despliegue actual (una sola instancia), y el
de Go tiene la misma restriccion por el mismo motivo: su cola tambien es local al proceso. Para
escalar horizontalmente habria que sacar el estado del proceso o darle a cada instancia su propio
writer node.
