# Ejemplos

- **`nonce-stress.ts`** — prueba de carga del manejo de nonces (este documento).
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
RELAYER_URL=http://localhost:3000
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
npx tsx examples/nonce-stress.ts --url http://otro-host:3000 --to 0xContrato
```

### Flags

| flag | default | que hace |
|---|---|---|
| `--n <N>` | `12` | metatx simultaneas **por usuario** |
| `--users <N>` | `1` | usuarios en paralelo. El 0 es el del `.env`; los extra son wallets random |
| `--to <addr>` | `TARGET_ADDRESS` | contrato destino |
| `--url <url>` | `RELAYER_URL` o `http://localhost:3000` | relayer a estresar |
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
relayer          : http://localhost:3000
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
todas: es que la cadena quede consistente igual. Pasarse del techo se manifiesta de dos formas
segun donde pegue la rafaga:

- `TOO_MANY_INFLIGHT` — la cadena ya tiene `maxInflight` metatx sin receipt.
- `BAD_NONCE` — lo que se lleno fue la cola de espera de `awaitTurn` (mismo techo), y la metatx
  entra a validar adelantada.

En ambos casos la conclusion es la misma y el script la imprime: **se pierden metatx, no se corrompe
el nonce**. Si la red mina rapido puede no rechazarse ninguna; ahi sale como `info`, no como falla.

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
