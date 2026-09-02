# Flujo del relayer

Diagramas del recorrido completo de una metatx por `simple_relay`: validaciones, los dos nonces,
los dos locks, las rafagas, el buffer de reordenamiento y como termina cada caso.

Todo lo que esta aca sale del codigo: `src/relayer.ts` (nucleo), `src/app.ts` (HTTP),
`src/rpc-proxy.ts` (JSON-RPC), `src/gas-model.ts` (forma de la metatx), `src/metatx.ts` (cliente).

---

## 1. Mapa general

```mermaid
flowchart LR
    subgraph cliente["Cliente"]
        DAPP["dapp / MetaTxClient<br/>firma la metatx<br/>(no paga gas)"]
    end

    subgraph relayer["simple_relay (una sola instancia por writer node)"]
        HTTP["src/app.ts<br/>GET /info<br/>GET /nonce/:addr<br/>POST /relay<br/>POST / (JSON-RPC)"]
        WS["src/ws-proxy.ts<br/>eth_subscribe"]
        PROXY["src/rpc-proxy.ts<br/>ruteo metodo a metodo"]
        CORE["src/relayer.ts<br/>validacion + nonces + envio"]
        TRACK["inflight (memoria)<br/>nonces del hub reservados"]
    end

    subgraph cadena["lnet / LACChain"]
        NODE["Besu writer node<br/>JSON-RPC crudo"]
        HUB["RelayHub (TxRelay)<br/>relayMetaTx / deployMetaTx"]
        DEST["Contrato destino"]
        RULES["AccountRules<br/>via AccountIngress 0x..8888"]
    end

    DAPP -- "rawTx firmada" --> HTTP
    DAPP -. "WebSocket" .-> WS
    HTTP --> PROXY
    WS --> PROXY
    PROXY -- "escrituras" --> CORE
    PROXY -- "lecturas: passthrough" --> NODE
    CORE <--> TRACK
    CORE -- "eth_call / eth_sendRawTransaction<br/>firmada por el writer node" --> NODE
    CORE -. "accountPermitted" .-> RULES
    NODE --> HUB
    HUB -- "call con msg.sender = usuario" --> DEST
```

Puntos clave del dibujo:

- El **usuario firma** una tx legacy con `chainId 0` y `gasPrice 0`; nunca toca la cadena.
- El **writer node** es el que firma y manda la tx real (`relayMetaTx`) y el que aparece como
  `msg.sender` frente al hub.
- El **hub** vuelve a poner al usuario como `msg.sender` frente al contrato destino.
- El `RPC_URL` tiene que ser el **JSON-RPC crudo de Besu**, no el relay-signer oficial.

---

## 2. Forma de la metatx

```mermaid
flowchart LR
    subgraph raw["raw tx que firma el usuario (tipo 0 / legacy)"]
        N["nonce = RelayHub.getNonce(user)<br/>NO el nonce de la cuenta"]
        GP["gasPrice = 0"]
        GL["gasLimit = gas del usuario"]
        TO["to = destino, o null si es deploy"]
        V["value = 0"]
        D["data = calldata + sufijo"]
    end

    subgraph sufijo["sufijo del modelo de gas: 64 bytes"]
        S1["abi.encode(address nodeAddress, uint256 expiration)"]
    end

    D --> sufijo
    raw -- "RLP de 6 campos = signingData" --> SIG["keccak256 -> firma ECDSA<br/>v, r, s"]
    SIG --> CALL["hub.relayMetaTx(gasLimit, signingData, v, r, s)"]
```

`gasLimit` que va al hub (igual que el relay-signer en Go, `src/gas-model.ts`):

```
metaTxGasLimit = len(data) * 105 + 300000 + gasLimit del usuario
```

---

## 3. Ciclo de vida de una metatx (detallado)

```mermaid
flowchart TD
    IN["rawTx entra<br/>POST /relay o eth_sendRawTransaction<br/>log: relay.received"] --> DES{"Transaction.from(rawTx)<br/>deserializa?"}
    DES -- no --> E1["BAD_RAW_TX"]
    DES -- si --> SHAPE{"validateMetaTxShape<br/>firmada? type 0? chainId 0?<br/>gasPrice 0? value 0? gasLimit > 0?"}
    SHAPE -- "hay problemas" --> E2["BAD_META_TX<br/>details = lista de problemas"]
    SHAPE -- ok --> SUF{"decodeGasModelSuffix<br/>data tiene los 64 bytes<br/>(nodeAddress, expiration)?"}
    SUF -- no --> E3["Error: data too short<br/>(500, no es RelayError)"]
    SUF -- si --> LOGD["log: relay.decoded<br/>from, to, nonce, selector,<br/>metaTxGasLimit, expiresInSeconds"]

    LOGD --> NODEADDR{"ENFORCE_NODE_ADDRESS<br/>nodeAddress == este writer node?"}
    NODEADDR -- no --> E4["WRONG_NODE_ADDRESS"]
    NODEADDR -- si --> EXP{"ENFORCE_EXPIRATION<br/>expiration > now?"}
    EXP -- no --> E5["EXPIRED"]
    EXP -- si --> EXPMIN{"remaining >= MIN_EXPIRATION_SECONDS<br/>menos la tolerancia?"}
    EXPMIN -- no --> E6["EXPIRATION_TOO_LOW"]
    EXPMIN -- si --> RULES{"ENFORCE_ACCOUNT_RULES?"}

    RULES -- "off (default)" --> TURN
    RULES -- on --> PERM{"accountPermitted(from)<br/>cache 30 s"}
    PERM -- "no se pudo leer" --> E7["PERMISSIONING_UNAVAILABLE<br/>fail closed"]
    PERM -- "false" --> E8["SENDER_NOT_PERMITTED"]
    PERM -- "true" --> TURN

    TURN["awaitTurn(from, nonce)<br/>FUERA del lock del usuario<br/>ver diagrama 5"] --> ULOCK["withUserLock(from)<br/>un envio a la vez por usuario"]

    ULOCK --> INFL{"pending >= MAX_INFLIGHT_PER_USER?"}
    INFL -- si --> E9["TOO_MANY_INFLIGHT<br/>(ultima red: el techo ya se<br/>chequeo en la puerta)"]
    INFL -- no --> EXPECT["expectedNonce =<br/>inflight.next si hay cadena,<br/>si no getNonce(from) por eth_call<br/>con from = writer node"]
    EXPECT --> NONCE{"expectedNonce == tx.nonce?"}
    NONCE -- no --> E10["BAD_NONCE<br/>details: expected, got, pending"]
    NONCE -- si --> SIM{"SIMULATE_BEFORE_SEND<br/>y no hay cadena en vuelo?"}

    SIM -- "no: metatx encadenada" --> SEND
    SIM -- si --> STATIC{"eth_call staticCall<br/>relayMetaTx / deployMetaTx"}
    STATIC -- "revierte" --> E11["SIMULATION_FAILED"]
    STATIC -- "errorCode != 8" --> E12["HUB_BADNONCE / HUB_NOTENOUGHGAS<br/>HUB_INVALIDSIGNATURE / ..."]
    STATIC -- "errorCode == 8 (OK)" --> SEND

    SEND["withNonceLock<br/>SECCION CRITICA GLOBAL<br/>ethers pide eth_getTransactionCount(pending)<br/>y manda la tx del writer node"] --> SENT{"el nodo la acepto?"}
    SENT -- no --> E13["SEND_FAILED + hint<br/>forgetInflight(from)"]
    SENT -- si --> RESERVE["inflight[from].next = expectedNonce + 1<br/>pending += 1<br/>cancela el borrado diferido"]
    RESERVE --> LOGS["log: relay.sent<br/>writerNodeNonce, hubNonce,<br/>simulated, pendingForUser"]
    LOGS --> NOTIFY["notifyTurn(from)<br/>despierta a la siguiente de la rafaga"]
    NOTIFY --> RET["devuelve el hash<br/>SIN esperar el receipt"]

    RET --> SETTLE["settle en background<br/>ver diagrama 6"]
    RET --> RESP{"por donde entro?"}
    RESP -- "POST /relay" --> R1["espera settled y responde<br/>el RelayResult completo"]
    RESP -- "eth_sendRawTransaction" --> R2["responde el hash;<br/>el dapp polea el receipt.<br/>El resultado final solo<br/>queda en el log relay.settled"]
```

---

## 4. Los dos nonces y los dos locks

Son dos cosas independientes y es lo que mas confusion genera:

| | quien lo elige | donde vive | como se serializa |
|---|---|---|---|
| nonce de la **metatx** | el usuario, va **firmado** en el RLP | `RelayHub.nonces[writerNode][user]` | `withUserLock` + tracker `inflight` |
| nonce de la **cuenta del writer node** | ethers, al mandar `relayMetaTx` | estado de la cuenta en la cadena | `withNonceLock` global |

```mermaid
flowchart TD
    subgraph porusuario["withUserLock(from): una reserva a la vez POR USUARIO"]
        U1["lee expectedNonce<br/>(inflight.next o getNonce)"] --> U2["valida contra tx.nonce"] --> U3["simula si corresponde"] --> U4["entra al lock global"]
    end

    subgraph global["withNonceLock: una asignacion a la vez EN TODO EL PROCESO"]
        G1["eth_getTransactionCount(node, pending)"] --> G2["firma la tx del writer node"] --> G3["eth_sendRawTransaction al nodo"]
    end

    U4 --> G1
    G3 --> U5["recien aca sube inflight.next<br/>y pending += 1"]

    NOTA["El orden se conserva porque el lock global asigna<br/>los nonces de la CUENTA en el mismo orden en que<br/>se reservaron los del HUB, y las tx de una EOA se<br/>ejecutan en orden de nonce: la metatx N se mina<br/>siempre antes que la N+1, aunque caigan en el mismo bloque."]
    U5 -.-> NOTA
```

Ninguno de los dos locks abarca la espera del receipt: si la abarcaran, un usuario quedaria
limitado a una metatx por bloque.

---

## 5. Rafaga del mismo usuario

El caso "N metatx concurrentes del mismo usuario". El cliente reparte nonces con un cursor local
y el relayer los encadena.

```mermaid
sequenceDiagram
    autonumber
    participant C as MetaTxClient
    participant R as Relayer
    participant T as inflight[user]
    participant N as Besu node
    participant H as RelayHub

    Note over C: allocNonce reparte 5, 6, 7 sin releer el relayer
    par tres envios concurrentes
        C->>R: POST /relay nonce 5
    and
        C->>R: POST /relay nonce 6
    and
        C->>R: POST /relay nonce 7
    end

    Note over R: llegan en cualquier orden,<br/>awaitTurn retiene a las adelantadas

    R->>T: no hay cadena -> getNonce(user) = 5
    R->>H: eth_call relayMetaTx (simulacion, solo la primera)
    H-->>R: errorCode 8 (OK)
    R->>N: tx writer node nonce 1780 (relayMetaTx nro 5)
    N-->>R: hash A
    R->>T: next = 6, pending = 1
    R-->>C: hash A
    Note over R: notifyTurn despierta a la nro 6

    R->>T: expected = 6 == tx.nonce
    Note over R: NO simula: hay cadena en vuelo<br/>(eth_call contra latest daria BadNonce)
    R->>N: tx writer node nonce 1781 (relayMetaTx nro 6)
    R->>T: next = 7, pending = 2
    R-->>C: hash B

    R->>T: expected = 7 == tx.nonce
    R->>N: tx writer node nonce 1782 (relayMetaTx nro 7)
    R->>T: next = 8, pending = 3
    R-->>C: hash C

    N->>H: se minan 1780, 1781, 1782 en orden
    H-->>R: receipt A, B, C
    R->>T: pending 2, 1, 0
    Note over T: pending = 0 -> borrado diferido<br/>a los REORDER_WINDOW_MS
```

Reglas que se ven en el diagrama:

- **Solo la primera de la rafaga se simula** (`simulated: true`); las encadenadas van sin
  pre-chequeo porque el `eth_call` corre contra `latest`, donde el nonce del hub todavia es viejo.
- El tope de la rafaga es `MAX_INFLIGHT_PER_USER` (`.env` actual: 6, default del codigo: 16).
- El nonce del **hub** avanza de a uno por metatx; el de la **cuenta del writer node** avanza en
  paralelo y es el que traba el txpool si algo se pierde.

---

## 6. `awaitTurn`: buffer de reordenamiento

Sobre HTTP el orden de llegada no esta garantizado y el hub exige el nonce exacto. Una metatx
adelantada espera en vez de morir con `BAD_NONCE`.

```mermaid
flowchart TD
    A["awaitTurn(user, nonce)"] --> B["deadline = now + REORDER_WINDOW_MS<br/>lastExpected = null"]
    B --> C["expected = inflight.next<br/>o getNonce(user)"]
    C --> D{"nonce <= expected?"}
    D -- si --> OK["le toca: sigue al lock del usuario"]
    D -- no --> E{"expected avanzo<br/>desde la ultima vuelta?"}
    E -- si --> F["renueva el deadline<br/>(la ventana mide ESTANCAMIENTO,<br/>no espera total)"]
    F --> G
    E -- no --> G{"queda tiempo?"}
    G -- no --> TO["sale igual;<br/>submit responde BAD_NONCE<br/>con el nonce correcto"]
    G -- si --> H{"pending + waiters >=<br/>MAX_INFLIGHT_PER_USER?"}
    H -- si --> E["TOO_MANY_INFLIGHT"]
    H -- no --> I["se duerme hasta:<br/>notifyTurn, o el timeout"]
    I --> C
```

`notifyTurn(user)` se dispara en dos momentos:

- despues de un envio exitoso (el nonce esperado avanzo);
- en `forgetInflight` (la cadena se descarto: hay que reevaluar contra la cadena real).

Si la ventana midiera la espera total, una rafaga larga perderia la cola por reloj: con ~1 s por
envio, la metatx 12 se caeria de una ventana de 3 s mientras el hub va por la quinta.

---

## 7. Estado de la cadena `inflight` de un usuario

```mermaid
stateDiagram-v2
    [*] --> SinCadena: no hay entrada en el Map

    SinCadena --> Activa: primer envio ok<br/>next = getNonce + 1, pending = 1
    Activa --> Activa: otro envio ok<br/>next += 1, pending += 1
    Activa --> Activa: receipt ok<br/>pending -= 1 (queda > 0)
    Activa --> Vaciandose: pending llega a 0<br/>timer de REORDER_WINDOW_MS

    Vaciandose --> Activa: llega otra metatx de la rafaga<br/>cancela el timer
    Vaciandose --> SinCadena: vence el timer<br/>la proxima relee la cadena

    Activa --> SinCadena: forgetInflight
    Vaciandose --> SinCadena: forgetInflight

    note right of SinCadena
        forgetInflight se llama cuando:
        - SEND_FAILED (el nodo rechazo la tx)
        - RECEIPT_TIMEOUT / NO_RECEIPT
        - BadTransactionSent (el hub rechazo la metatx)
        Siempre dispara notifyTurn.
    end note

    note left of Vaciandose
        La gracia existe porque el cliente puede tener
        metatx de la misma rafaga todavia en camino:
        si se borrara al instante, nextNonce caeria al
        nonce minado y un reintento pisaria un nonce ya tomado.
    end note
```

---

## 8. `settle`: que pasa cuando se mina

```mermaid
flowchart TD
    A["settle: espera el receipt<br/>techo RECEIPT_TIMEOUT_MS (60 s)"] --> B{"llego el receipt?"}
    B -- "timeout" --> T["RECEIPT_TIMEOUT<br/>forgetInflight + releasePending<br/>el nonce del writer node quedo consumido:<br/>hay que mirar el txpool del nodo"]
    B -- "null" --> NR["NO_RECEIPT<br/>forgetInflight"]
    B -- si --> P["parseHubLogs: solo logs del RelayHub"]

    P --> Q{"que evento emitio el hub?"}
    Q -- "TransactionRelayed executed=true" --> OK["exito<br/>output = return data del destino<br/>el nonce del hub AVANZO"]
    Q -- "TransactionRelayed executed=false" --> REV["el destino revirtio<br/>output = revert reason<br/>el nonce AVANZA: la cadena sigue sana"]
    Q -- "ContractDeployed" --> DEP["deploy ok<br/>deployedAddress = contractDeployed"]
    Q -- "BadTransactionSent" --> BAD["el hub rechazo la metatx<br/>errorCode != 8<br/>el nonce NO avanzo"]

    BAD --> BAD2["forgetInflight(from)<br/>log: relay.hub_rejected<br/>TODAS las encadenadas detras<br/>quedan invalidas y gastan<br/>una tx del writer node cada una"]

    OK --> R["RelayResult"]
    REV --> R
    DEP --> R
    R --> L["log: relay.settled"]
```

Y para el dapp que polea por JSON-RPC, `enrichReceipt` reescribe el receipt crudo del nodo para
que refleje **su** metatx y no la tx del writer node:

```mermaid
flowchart LR
    A["receipt crudo del nodo<br/>status 1, contractAddress null"] --> B{"logs del RelayHub"}
    B -- "ContractDeployed" --> C["contractAddress = direccion desplegada"]
    B -- "TransactionRelayed executed=false" --> D["status = 0x0<br/>revertReason = output"]
    B -- "BadTransactionSent" --> E["status = 0x0<br/>relayErrorCode + relayErrorCodeName"]
    B -- "nada" --> F["se devuelve igual"]
```

---

## 9. Ruteo del proxy JSON-RPC

```mermaid
flowchart TD
    A["POST / con JSON-RPC<br/>(suelto o batch)"] --> B{"es batch?"}
    B -- si --> C["se parte entrada por entrada<br/>(reenviar el body entero dejaria pasar<br/>un eth_sendRawTransaction crudo al nodo)"]
    B -- no --> D
    C --> D{"metodo"}

    D -- "eth_sendRawTransaction" --> S["submitRelay: se relaya como metatx<br/>devuelve el hash sin esperar receipt"]
    D -- "eth_getTransactionCount" --> N{"parametro de bloque"}
    N -- "latest" --> N1["getNonce: lo minado en el hub"]
    N -- "pending o vacio" --> N2["nextNonce: cuenta lo que hay en vuelo<br/>es el que hay que firmar"]
    D -- "eth_getTransactionReceipt" --> RC["passthrough + enrichReceipt"]
    D -- "eth_sendTransaction<br/>eth_sign / eth_signTransaction" --> NS["-32601: el relayer no custodia<br/>la clave del usuario"]
    D -- "eth_accounts / eth_requestAccounts" --> AC["[] (lista vacia)"]
    D -- "todo lo demas" --> PT["passthrough crudo al nodo<br/>las de un batch se agrupan<br/>en un solo round-trip"]

    subgraph ws["Sobre WebSocket (src/ws-proxy.ts)"]
        W1["mismo ruteo"] --> W2["+ eth_subscribe / eth_unsubscribe<br/>una conexion al nodo POR CLIENTE"]
    end
```

---

## 10. Cliente: cursor de nonce y reintento

```mermaid
flowchart TD
    A["send()"] --> B{"el caller fijo el nonce?"}
    B -- si --> C["firma y manda; sin reintento<br/>(lo eligio a proposito)"]
    B -- no --> D["allocNonce: cursor local<br/>si esta vacio, lo lee de<br/>GET /nonce/:addr -> nextNonce"]
    D --> E["sign: arma la tx tipo 0,<br/>agrega el sufijo, firma"]
    E --> F["POST /relay o eth_sendRawTransaction"]
    F --> G{"respuesta"}
    G -- "ok" --> H["RelayResponse"]
    G -- "code != BAD_NONCE" --> I["tira el error"]
    G -- "BAD_NONCE" --> J["invalidateNonce(generation)<br/>la generacion evita que N reintentos<br/>concurrentes invaliden en cadena"]
    J --> K{"quedan intentos?<br/>(1 + nonceRetries, default 3)"}
    K -- si --> D
    K -- no --> I
```

Sin el cursor, N `send()` concurrentes firmarian todos el mismo nonce.

---

## 11. Referencia de errores

Errores del relayer (`RelayError.code`); por REST salen como HTTP 400, por JSON-RPC como `-32000`:

| code | cuando | rompe la cadena de nonces |
|---|---|---|
| `BAD_RAW_TX` | la raw tx no deserializa | no |
| `BAD_META_TX` | no cumple la forma del modelo de gas | no |
| `WRONG_NODE_ADDRESS` | el sufijo apunta a otro writer node | no |
| `EXPIRED` / `EXPIRATION_TOO_LOW` | expiration vencida o al filo | no |
| `SENDER_NOT_PERMITTED` / `PERMISSIONING_UNAVAILABLE` | solo con `ENFORCE_ACCOUNT_RULES=true` | no |
| `TOO_MANY_INFLIGHT` | tope de rafaga por address (enviadas sin receipt + retenidas) | no |
| `BAD_NONCE` | el nonce firmado no es el esperado | no |
| `SIMULATION_FAILED` / `HUB_*` | la simulacion previa dice que el hub la rechazaria | no |
| `SEND_FAILED` | el nodo rechazo la tx del writer node | **si** |
| `RECEIPT_TIMEOUT` / `NO_RECEIPT` | se mando pero no se mino | **si** |

`ErrorCode` del hub (`enum IRelayHub.ErrorCode`, `OK` = 8):

| 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 |
|---|---|---|---|---|---|---|---|---|
| MaxBlockGasLimit | BadOriginalSender | BadNonce | NotEnoughGas | IsNotContract | EmptyCode | InvalidSignature | InvalidDestination | **OK** |

---

## 12. Como se ve en el log

Una metatx exitosa deja esta secuencia (cada linea lleva `reqId` e `instanceId`):

```mermaid
flowchart LR
    A["http.request"] --> B["relay.received"] --> C["relay.decoded"] --> D["relay.sent"] --> E["http.response"] --> F["relay.settled"]
```

`relay.settled` llega **despues** de la respuesta HTTP en el camino JSON-RPC: es la unica traza
del resultado final de una metatx mandada por `eth_sendRawTransaction`. Variantes:

- `relay.rejected` en lugar de `relay.sent`: se rechazo antes de mandar nada.
- `relay.hub_rejected` antes de `relay.settled`: se mino pero el hub la rechazo.
- `relay.settle_failed`: `RECEIPT_TIMEOUT` o `NO_RECEIPT`.
- `relayer.ready` / `boot`: cold start, tracker de nonces vacio.

---

## 13. Supuestos y limites

```mermaid
flowchart TD
    A["El tracker inflight vive<br/>en memoria del proceso"] --> B["Una sola instancia<br/>por clave de writer node"]
    B --> C["Dos instancias se pisarian<br/>en el nonce de la cuenta<br/>Y en el del hub"]
    B --> D["Reinicio: el tracker arranca vacio<br/>y resincroniza leyendo la cadena.<br/>Hueco: reiniciar con metatx en vuelo"]
    B --> E["Para escalar: sacar el tracker<br/>del proceso, o un writer node<br/>por instancia"]
```

Fuera del relayer, dos cosas dependen de la red y no de este codigo:

- que el **writer node este permisionado** (`addNode` en el hub + `addAccount` en AccountRules);
- que el nodo **propague y mine** lo que acepta: si el nodo encola la tx pero la red no la
  incluye, el sintoma es `RECEIPT_TIMEOUT` con el nonce de la cuenta ya consumido.
