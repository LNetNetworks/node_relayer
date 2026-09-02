# Ejemplos

- **`nonce-stress.ts`** — prueba de carga del manejo de nonces (este documento).
- **`sequential-test.ts`** — la contracara: metatx de a una, con el nonce puesto por el cliente.
  Ver [Prueba secuencial](#prueba-secuencial-sequential-testts) mas abajo.
- **`hardhat-storage/`** — deploy de `Storage.sol` con Hardhat a traves del relayer, usando el
  `LacchainSigner` oficial sin modificar. Ver su propio [README](hardhat-storage/README.md).

---

# Prueba de carga de nonces (`nonce-stress.ts`)

Manda muchas metatx **simultaneas** contra el relayer y verifica que las encadene sin huecos, sin
repetidos y sin perder ninguna. Es la prueba que hay que correr despues de tocar cualquier cosa de
`src/relayer.ts` que huela a nonces, locks o concurrencia.

La rafaga va por el **proxy JSON-RPC** (`POST /`), que es por donde entra un dapp de verdad:
`eth_getTransactionCount` para el nonce, `eth_sendRawTransaction` para mandar (devuelve el hash al
toque, sin esperar el receipt) y poleo de `eth_getTransactionReceipt` para el resultado. Asi la
carga pega en el camino que se usa en serio, con las tres intercepciones del proxy adentro.
`--rest` vuelve al camino corto (`POST /relay`, que responde recien con el receipt ya decodificado)
para comparar los dos. Lo unico que sigue yendo por REST en los dos modos es el `GET /info` del
arranque: no hay metodo JSON-RPC que exponga la config del relayer, y es descubrimiento previo, no
parte de la rafaga.

## Que se esta estresando

Hay tres piezas que una rafaga concurrente puede romper, y cada una falla distinto:

| pieza | quien la maneja | sintoma si esta mal |
|---|---|---|
| **nonce del RelayHub** (`nonces[writerNode][usuario]`, va firmado en la metatx) | el relayer, con la contabilidad en memoria de lo que ya reservo | `BAD_NONCE` o huecos en la cadena |
| **nonce de la cuenta del writer node** (la tx externa) | ethers dentro del `send`, serializado por un lock global | dos tx con el mismo nonce: una reemplaza a la otra en el txpool y la reemplazada nunca se mina → `RECEIPT_TIMEOUT` |
| **cursor local del cliente** | `MetaTxClient` | N `send()` concurrentes firmarian todos el mismo nonce |
| **el proxy JSON-RPC** (salvo con `--rest`) | `src/rpc-proxy.ts` | `eth_getTransactionCount` que devolviera el nonce de la cuenta en vez del del hub: la rafaga entera firmaria el mismo nonce. Un receipt sin reescribir diria `ejecutada` aunque la llamada del usuario haya revertido |

## Antes de correrla

1. **Un relayer levantado** (`npm start` en la raiz), apuntando a un nodo con RPC crudo.
2. **`USER_PRIVATE_KEY`** en el `.env`. No necesita fondos ni permisos: solo firma.
3. **`TARGET_ADDRESS`**: un contrato ya desplegado con `store(uint256)` y `retrieve()`. Si no
   tenes uno, `npm run test:deploy` despliega `Storage.sol` por metatx e imprime la direccion.

```sh
# .env, en la raiz del repo
RELAYER_URL=http://localhost:3001
USER_PRIVATE_KEY=0x...
TARGET_ADDRESS=0x...
```

> **Supuesto importante:** el relayer apuntado tiene que ser el **unico proceso usando esa clave de
> writer node**. Dos instancias compartiendola se pisan en el nonce de la cuenta, y esta prueba lo
> marca como `RECEIPT_TIMEOUT` — que es justamente el sintoma que hay que reconocer.

## Como se corre

Desde la raiz del repo:

```sh
npm run test:nonces                      # 12 metatx simultaneas de un usuario
npm run test:nonces -- --n 16            # rafaga mas grande
npm run test:nonces -- --users 3 --n 8   # 3 usuarios en paralelo (24 metatx en total)
npm run test:nonces -- --overflow        # pasarse a proposito de MAX_INFLIGHT_PER_USER
npm run test:nonces -- --quiet           # sin la traza por metatx, solo resumen y verificaciones
npm run test:nonces -- --rest            # por POST /relay en vez del proxy JSON-RPC
```

El `--` antes de los flags es necesario: sin el, npm se los come en vez de pasarselos al script.
Tambien se puede invocar directo, y ahi los flags van sueltos:

```sh
npx tsx examples/nonce-stress.ts --n 20 --users 3
npx tsx examples/nonce-stress.ts --url http://otro-host:3001 --to 0xContrato
```

### Flags

| flag | default | que hace |
|---|---|---|
| `--n <N>` | `12` | metatx simultaneas **por usuario** |
| `--users <N>` | `1` | usuarios en paralelo. El 0 es el del `.env`; los extra son wallets random |
| `--to <addr>` | `TARGET_ADDRESS` | contrato destino |
| `--url <url>` | `RELAYER_URL` o `http://localhost:3001` | relayer a estresar |
| `--overflow` | — | ignora `--n` y manda `MAX_INFLIGHT_PER_USER + 4`, para ver el techo |
| `--verbose`, `-v` | **prendido** | traza por metatx: firma, refirmas, receipt y latencia |
| `--quiet`, `-q` | — | apaga la traza: queda el resumen y las verificaciones |
| `--rpc` | **prendido** | manda por el proxy JSON-RPC (`POST /`), como un dapp |
| `--rest` | — | manda por `POST /relay`. Se ve mas de cada metatx (`simulada`, eventos) porque el relayer devuelve el resultado decodificado en vez del receipt |

Los usuarios extra de `--users` son wallets random sin fondos: en el modelo de gas no necesitan
nada, solo firmar. Con `ENFORCE_ACCOUNT_RULES=true` en el relayer no estan permisionados y serian
rechazados, asi que el script aborta antes de intentarlo y pide correr con `--users 1`.

`MAX_INFLIGHT_PER_USER` no se pasa por flag: el script lo lee de `GET /info` del relayer. Para
moverlo hay que cambiarlo en el `.env` del relayer y reiniciarlo.

## Salida esperada

Por defecto va **verboso**: cada metatx deja rastro con el reloj de la rafaga, para poder mirarla
mientras pasa. El orden de las lineas es el real (`arranca` sale antes que `firma` porque el nonce
y el gas se resuelven adentro del `send()`), y `refirmaN` solo aparece cuando el relayer contesto
`BAD_NONCE` y el cliente resincronizo el cursor.

```
relayer          : http://localhost:3001
writer node      : 0x248906Bf539e8f16FbD14c001f7Bd3D712f95D3E
contrato destino : 0x51C99a2edB680e4124768c406e079E6C722112f7
MAX_INFLIGHT     : 16 por usuario
rafaga           : 12 metatx simultaneas x 1 usuario(s)
transporte       : proxy JSON-RPC (POST /, como un dapp)
modo             : verboso (--quiet para el resumen solo)

/info completo del relayer:
  nodeAddress              "0x248906Bf539e8f16FbD14c001f7Bd3D712f95D3E"
  relayHubAddress          "0x..."
  chainId                  "648"
  maxInflightPerUser       16
  enforceAccountRules      false

usuario 0        : 0x0255F6F1976d8476CF127a0B1c2971e9a06c9eE1 (nonce del hub 7)

enviando 12 metatx...
[  0.003s] u0#00   arranca    destino 0x51C99a2edB680e4124768c406e079E6C722112f7
[  0.021s] u0#00   firma      nonce hub 7  gasLimit 55123  metaTxGasLimit 366400
[  1.204s] u0#00   OK         nonce hub 7  bloque 61507080  gas 48211  ejecutada  tx 0x1a2b3c4d..9f0e1d  1201 ms
[  1.288s] u0#01   OK         nonce hub 8  bloque 61507080  gas 48211  ejecutada  tx 0x7788aabb..c0ffee  1285 ms
...

12/12 aceptadas en 4310 ms (2.8 metatx/s)
metatx por bloque: 61507080: 5 | 61507081: 4 | 61507082: 3
latencia por metatx: min 1201 ms | p50 2380 ms | p90 4102 ms | max 4308 ms
gas total de las aceptadas: 578532 | refirmas por BAD_NONCE: 0 | bloques tocados: 3

detalle usuario 0 (0x0255F6F1976d8476CF127a0B1c2971e9a06c9eE1):
  u0#00  nonce    7  bloque 61507080  gas   48211   1201 ms  ejecutada  tx 0x1a2b3c4d..9f0e1d
  u0#01  nonce    8  bloque 61507080  gas   48211   1285 ms  ejecutada  tx 0x7788aabb..c0ffee
  ...

verificaciones:
  info    usuario 0: nonces devueltos = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]  (hub antes 7, hub despues 19)
  ok      usuario 0: 12 nonces consecutivos 7..18
  ok      usuario 0: el nonce del hub quedo en 19 (= 7 + 12 minadas)
  info    por el proxy JSON-RPC no se ve si el relayer simulo: el receipt no lo dice (con --rest si)
  ok      las 12 aceptadas se ejecutaron en el contrato destino
  ok      no quedaron metatx en vuelo (pending = 0 para todos los usuarios)
  info    retrieve() = 10011 (gana la ultima minada, cualquiera de las 12 es valida)

prueba OK: el manejo de nonces aguanto la rafaga
```

Con `--quiet` desaparecen el `/info` completo, la traza, las latencias y el detalle por usuario:
queda el encabezado, el resumen y el bloque de verificaciones.

Con `--rest` cada metatx suma la columna `simulada` / `encadenada` y los eventos del hub: el
receipt que devuelve el proxy no trae esos datos, `POST /relay` si.

Ojo con las latencias: por el proxy la latencia por metatx incluye el poleo del receipt (se mide
hasta que aparece, con el intervalo de poleo adentro), asi que da mas alta que por `--rest` aunque
la metatx se haya minado en el mismo bloque. Lo comparable entre los dos modos es el total de la
rafaga y las metatx por bloque, no el numero por metatx.

### Que mirar en la traza

| campo | que dice |
|---|---|
| `[  1.204s]` | reloj desde que arranco la rafaga (no desde que arranco el proceso) |
| `u0#03` | usuario 0, cuarta metatx de su rafaga |
| `firma` / `refirmaN` | nonce del hub que se firmo. `refirmaN` = hubo `BAD_NONCE` y el cliente resincronizo |
| `simulada` / `encadenada` | solo con `--rest`: si el relayer la pre-chequeo o la mando encadenada sobre otra en vuelo |
| `reintentos N` (detalle) | cuantas refirmas necesito esa metatx |
| `refirmas por BAD_NONCE` | total de la corrida. En una rafaga sana de un solo cliente deberia ser 0 |

Sale con **codigo 0 si todo paso** y **1 si alguna verificacion fallo** (`FAIL` en la salida), asi
que sirve tal cual en CI. Las lineas `info` no marcan falla: son datos.

Medido en open-protestnet: **16/16 en 5 bloques** con un usuario y **24/24 con 3 usuarios**.

## Que verifica cada linea

| verificacion | que probaria si fallara |
|---|---|
| **nonces consecutivos desde el nonce del hub** | la contabilidad en memoria del relayer perdio o repitio un nonce reservado |
| **el nonce del hub quedo en `start + minadas`** | alguna metatx se dio por aceptada sin minarse de verdad |
| **una simulada por cadena como maximo** (solo con `--rest`) | las encadenadas se estan simulando de mas (correrian contra `latest`, donde el nonce del hub todavia es el viejo, y darian `BadNonce`). Si aparece como `info` con un numero mayor, hubo cadenas que se vaciaron en medio de la rafaga: no es un error, es que el hub iba mas rapido que los envios |
| **todas las aceptadas se ejecutaron** | el hub relayo pero la llamada del usuario revirtio |
| **`pending = 0` al final** | quedaron metatx en vuelo: alguna reserva nunca se libero |

## Modo overflow

`--overflow` manda `MAX_INFLIGHT_PER_USER + 4` a proposito. Lo que se espera **no** es que entren
todas: es que la cadena quede consistente igual. Las que se pasan se rechazan con
`TOO_MANY_INFLIGHT` — el address ya tiene `maxInflight` metatx tomadas por el relayer, contando
las enviadas sin receipt y las retenidas en `awaitTurn`. La conclusion la imprime el script:
**se pierden metatx, no se corrompe el nonce**. Si la red mina rapido puede no rechazarse ninguna;
ahi sale como `info`, no como falla.

## Cuando algo falla

| sintoma | causa tipica |
|---|---|
| `GET /info devolvio ...` / connection refused | no hay relayer en esa URL |
| `Falta el contrato destino` / `Falta USER_PRIVATE_KEY` | falta `.env` (o pasar `--to`) |
| `RECEIPT_TIMEOUT` en varias | **dos relayers compartiendo la clave del writer node**, o un techo de espera corto para lo que tarda la red en minar (`RECEIPT_TIMEOUT_MS` del relayer con `--rest`; por el proxy el techo es el del poleo del cliente, 60 s) |
| `BAD_NONCE` en una rafaga que deberia entrar entera | se rompio la cadena: mirar los logs del relayer por `BadTransactionSent` |
| `NotEnoughGas` / rechazos del hub | el writer node no esta dado de alta o se quedo sin cupo de gas por bloque |
| aborta pidiendo `--users 1` | el relayer corre con `ENFORCE_ACCOUNT_RULES=true` y los usuarios random no estan permisionados |

Para el detalle de por que el diseno es asi (buffer de reordenamiento, gracia antes de olvidar la
cadena, que rompe la cadena y que no), ver **Nonces y concurrencia** en el
[README de la raiz](../README.md#nonces-y-concurrencia).

---

# Prueba secuencial (`sequential-test.ts`)

La contracara de la prueba de carga: manda las metatx **de a una** y con el nonce puesto por el
cliente, que se hace cargo de mandarlas en orden. Cada metatx espera su receipt antes de que se
firme la siguiente.

El nonce va **fijado en el `send()`** (`send({ nonce })`), llevado en un contador local que arranca
en el nonce del hub. Ese camino es distinto en un punto que importa: con el nonce fijado a mano
`MetaTxClient` **no reintenta** ante `BAD_NONCE` — lo elegiste vos, refirmarlo con otro numero
seria peor que el error —, asi que cualquier desalineacion se ve como falla en vez de taparse con
una refirma. La rafaga de `nonce-stress.ts` nunca pasa por ahi: ahi el nonce lo reparte el cursor
del cliente y los `BAD_NONCE` se reintentan solos.

## Que verifica que la rafaga no puede

| verificacion | que probaria si fallara |
|---|---|
| **la cadena entra entera, sin refirmas** | un cliente ordenado que cuenta 1, 2, 3 desde el nonce del hub tiene que entrar siempre: cada metatx llega cuando la anterior ya se mino, sin reordenamiento de por medio |
| **una sola firma por metatx** | el `send()` reintento por su cuenta con un nonce fijado a mano |
| **el nonce del hub sube exactamente 1 por metatx** (se lee despues de cada una) | se salteo un nonce (una metatx de mas) o se quedo (una que se dio por aceptada sin minarse) |
| **`retrieve()` devuelve lo recien escrito, en cada paso** | el orden no se respeto en la cadena. En la rafaga concurrente esto no se puede afirmar: gana la ultima minada, cualquiera es valida |
| **`pending = 0` al final** | quedaron metatx en vuelo: alguna reserva nunca se libero |

## Como se corre

Mismos requisitos que la prueba de carga (relayer levantado, `USER_PRIVATE_KEY` y `TARGET_ADDRESS`
en el `.env`). Desde la raiz del repo:

```sh
npm run test:sequential                  # 6 metatx, una atras de la otra
npm run test:sequential -- --n 12
npm run test:sequential -- --ask         # pidiendole el nonce al relayer antes de cada una
npm run test:sequential -- --gap         # saltearse un nonce a proposito
npm run test:sequential -- --rest        # por POST /relay en vez del proxy JSON-RPC
npm run test:sequential -- --quiet
```

### Flags

| flag | default | que hace |
|---|---|---|
| `--n <N>` | `6` | metatx a mandar, una despues de la otra |
| `--to <addr>` | `TARGET_ADDRESS` | contrato destino |
| `--url <url>` | `RELAYER_URL` o `http://localhost:3001` | relayer a probar |
| `--ask` | — | pide el nonce al relayer antes de cada metatx en vez de contarlo local, y compara los dos |
| `--gap` | — | fase extra al final: saltearse un nonce a proposito |
| `--verbose`, `-v` | **prendido** | traza por metatx: firma, receipt, nonce del hub y `retrieve()` |
| `--quiet`, `-q` | — | apaga la traza: queda el resumen y las verificaciones |
| `--rpc` | **prendido** | manda por el proxy JSON-RPC (`POST /`), como un dapp |
| `--rest` | — | manda por `POST /relay`, que devuelve el resultado decodificado (`simulada`, eventos) |

Con `--ask` el numero lo elige el relayer (`eth_getTransactionCount` con `'pending'`, o
`GET /nonce/:address` con `--rest`): secuencial tiene que dar lo mismo que el contador local, y el
script marca falla si difieren. Ojo que en ese modo lo que se prueba es el endpoint del nonce, no
el cliente ordenado.

> **Supuesto:** nadie mas manda metatx de ese usuario mientras corre. Un segundo cliente
> consumiendo nonces del mismo address rompe la premisa (el contador local queda viejo) y se ve
> como `BAD_NONCE`. Si al arrancar hay metatx en vuelo, el script lo avisa y arranca igual desde el
> nonce `pending`.

## Salida esperada

```
relayer          : http://localhost:3001
writer node      : 0x248906Bf539e8f16FbD14c001f7Bd3D712f95D3E
contrato destino : 0x51C99a2edB680e4124768c406e079E6C722112f7
secuencia        : 6 metatx de a una (se espera el receipt de cada una)
nonce            : contador del cliente, fijado en el send()
transporte       : proxy JSON-RPC (POST /, como un dapp)
modo             : verboso (--quiet para el resumen solo)

usuario          : 0x0255F6F1976d8476CF127a0B1c2971e9a06c9eE1 (nonce del hub 19)

mandando 6 metatx desde el nonce 19...

[  0.002s] #00   arranca    nonce hub 19  store(482301)
[  0.020s] #00   firma      nonce hub 19  gasLimit 55123  metaTxGasLimit 366400
[  1.210s] #00   OK         nonce hub 19  bloque 61507085  gas 48211  ejecutada  tx 0x1a2b3c4d..9f0e1d  1208 ms
[  1.260s] #00   hub        nonce minado 19 -> 20
[  1.301s] #00   retrieve   482301
...

6/6 aceptadas en 7620 ms (1270 ms por metatx)
latencia por metatx: min 1208 ms | p50 1265 ms | p90 1310 ms | max 1322 ms
gas total: 289266 | bloques tocados: 6 (una metatx por bloque como maximo: se espera el receipt)

detalle (0x0255F6F1976d8476CF127a0B1c2971e9a06c9eE1):
  #00  nonce   19  bloque 61507085  gas   48211   1208 ms  ejecutada  store(482301)  tx 0x1a2b3c4d..9f0e1d
  ...

verificaciones:
  ok      las 6 metatx entraron
  ok      6 nonces consecutivos 19..24, en el orden en que se mandaron
  ok      una sola firma por metatx (6): sin refirmas, el nonce lo puso el cliente
  ok      el nonce del hub quedo en 25 (= 19 + 6 minadas)
  ok      las 6 aceptadas se ejecutaron en el contrato destino
  ok      retrieve() = 482306: quedo el valor de la ultima metatx, no el de otra
  ok      no quedaron metatx en vuelo (pending = 0)
  info    por el proxy JSON-RPC no se ve si el relayer simulo: el receipt no lo dice (con --rest si)

prueba OK: mandando de a una y en orden, el relayer acepta todo sin reordenar ni refirmar
```

Con `--rest` la linea de simulacion cambia por el conteo real. No esperes que sean todas: la cadena
en memoria del relayer **sobrevive `REORDER_WINDOW_MS` al ultimo receipt** (esta ahi justamente
para el cliente que sigue mandando), asi que en una secuencia rapida las siguientes salen
encadenadas, igual que en una rafaga. Solo se pre-simula la que llega con la cadena ya vencida.

Sale con **codigo 0 si todo paso** y **1 si alguna verificacion fallo**. Al primer rechazo la
secuencia se corta: en secuencial una metatx que no entro deja el contador adelantado y todas las
que siguen serian `BAD_NONCE` por arrastre, sin agregar informacion.

## Fase `--gap`: el cliente se saltea un nonce

Es el caso que esta prueba pone en el cliente, mirado al reves: que pasa cuando el que tenia que
ordenar los nonces se equivoca. Se manda una metatx con el nonce adelantado en uno y despues la
que iba en orden. Lo esperado:

1. la adelantada queda retenida en el **buffer de reordenamiento** (por si la que falta venia
   atrasada en la red) y, al vencer `REORDER_WINDOW_MS` sin que aparezca, se rechaza con
   `BAD_NONCE` diciendo que nonce espera el hub — asi que esta fase tarda esa ventana de mas;
2. el nonce del hub **no se movio**;
3. la siguiente en orden entra normal.

La conclusion es la misma que la del modo overflow de la prueba de carga: **un cliente desordenado
pierde su metatx, no rompe la cadena del usuario**.

Para el detalle del diseno (buffer de reordenamiento, gracia antes de olvidar la cadena, que rompe
la cadena y que no), ver **Nonces y concurrencia** en el
[README de la raiz](../README.md#nonces-y-concurrencia).
