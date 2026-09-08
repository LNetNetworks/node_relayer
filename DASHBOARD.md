# Dashboard: monitor en vivo del relayer

Pagina que sirve el propio relayer en `GET /dashboard` para **ver que hace el manejo de nonces**:
en que orden llegaron las metatx por HTTP, cuales quedaron retenidas en el buffer de
reordenamiento, en que orden salieron al hub y cuanto tardo cada fase.

No es una instrumentacion aparte: el bus de eventos (`src/events.ts`) es un **derivado del log
estructurado**. Cada linea que emite `src/log.ts` pasa por el bus sin que el relayer sepa que
existe un dashboard, asi que no hay dos verdades sobre lo que paso y agregar un evento al log lo
agrega a la pagina.

## Levantarlo

```bash
npm start                      # dashboard en http://localhost:3000/dashboard
npm run test:nonces -- --n 6   # una rafaga para que haya algo que mirar
```

| Variable | Default | Que hace |
|---|---|---|
| `DASHBOARD` | `true` | `false` apaga la pagina **y el bus entero** (`publish` queda en un `return`: no se paga nada por linea de log) |
| `DASHBOARD_BUFFER` | `500` | eventos guardados para el que se conecta tarde |

## Arquitectura

```
src/log.ts  --publish-->  src/events.ts (ring buffer + subscribers)
                                 |
                                 +--> GET /dashboard/stream  (SSE)  --> src/dashboard-page.ts (la pagina)
```

- **`src/events.ts`** — buffer circular en memoria (`DASHBOARD_BUFFER`, 500) y `Set` de
  suscriptores. Cada evento lleva un `seq` incremental.
- **`src/dashboard.ts`** — dos rutas: `/dashboard` (HTML) y `/dashboard/stream` (SSE). Al conectar
  hace **replay** del buffer (`?after=<seq>` o la cabecera `last-event-id` del reintento del
  browser) y recien despues se suscribe, sin `await` en el medio: no hay ventana por donde se
  pierda un evento. Heartbeat cada 15 s, `X-Accel-Buffering: no` para que un nginx delante no
  retenga el stream, y techo de **8 clientes** (el noveno recibe `503`).
- **`src/dashboard-page.ts`** — la pagina entera (HTML+CSS+JS inline, sin dependencias ni build).
  Reconstruye el estado de cada metatx a partir de los eventos y lo dibuja.

Como el buffer se reenvia completo al conectar, **abrir la pagina despues de la rafaga igual la
muestra** (mientras entre en el buffer).

## Los eventos que alimentan la vista

Una metatx pasa por esta secuencia; cada evento mueve su estado en la pagina:

| Evento | Estado | Campos que usa la UI |
|---|---|---|
| `relay.received` | `recibida` | `metaTxId`, `from`, `rawTxHash` |
| `relay.decoded` | — | `nonce`, `to`, `gasLimit`, `nodeAddress`, `expiration` |
| `relay.held` | `en espera` | `nonce`, `expected`, **`gap`** (cuantos nonces adelantada llego), `windowMs` |
| `relay.turn` | — | `heldMs` (cuanto estuvo retenida), `reason` (`in_turn`, …) |
| `relay.sent` | `en la cadena` | `transactionHash`, `hubNonce`, `writerNodeNonce`, `simulated`, `simulatedErrorCodeName`, `pendingForUser` |
| `relay.settled` | `minada` / `revirtio` | `blockNumber`, `gasUsed`, `executed`, `errorCodeName`, `events`, `deployedAddress` |
| `relay.rejected` | `rechazada` | `code` (`BAD_NONCE`, `EXPIRED`, `TOO_MANY_INFLIGHT`, …) |

## La interfaz, panel por panel

### Cabecera y tira de metricas

Arriba: `en vivo` (verde si el SSE esta conectado), `instancia`, `pid`, `chain`, `hub`, `writer`,
**`ventana de reorden`** y **`max en vuelo`** — o sea, `REORDER_WINDOW_MS` y `MAX_INFLIGHT_PER_USER`
a la vista, que son los dos parametros que gobiernan la cola.

Siete contadores: `metatx`, `en espera` (retenidas ahora), `en la cadena` (enviadas sin receipt),
`minadas`, `fallidas`, **`reordenadas`** y **`espera media`**.

`reordenadas` no compara indices globales: agrupa por `from` y compara la posicion de llegada
contra la de envio **dentro de cada usuario** (`reorderedIds()`), porque el orden lo impone la
cadena de nonces de cada uno y un rechazo en el medio marcaria como reordenada a cualquiera.

### Panel "Reordenamiento — llegada contra envio al hub"

**Es la vista de la cache de encolamiento.** Dos columnas de tarjetas:

- **izquierda, orden de llegada** — como entraron por HTTP, en el orden real de la request.
- **derecha, orden de envio** — como salieron al hub, por cadena de nonces.

Entre las dos, un SVG dibuja una linea por metatx uniendo su posicion en una columna con la de la
otra. **Las lineas que se cruzan (en ambar) son exactamente las metatx reordenadas**: llegaron
adelantadas, esperaron en el buffer a que se cerrara el hueco y salieron en su turno.

Cada tarjeta lleva el estado con glifo y color (`○ recibida`, `⏸ en espera`, `→ en la cadena`,
`✓ minada`, `✗ revirtio/rechazada`), el `from` acortado y el **nonce del hub**. Al pasar el mouse
sale un tooltip con el detalle: nonce, cuanto estuvo retenida, cuantos nonces adelantada llego, el
nonce del writer node y el hash.

Se muestran las ultimas 24 filas (`MAX_ROWS`).

### Panel "Linea de tiempo de cada metatx"

Una barra por metatx con las fases coloreadas: **gris** en el relayer (validacion, simulacion),
**ambar** retenida en el buffer, **azul** en la cadena (enviada, esperando receipt), y al final
`✓` minada o `✗` fallida. El eje es tiempo real desde la primera metatx de la ventana.

Aca se lee de un vistazo lo que la cola esta haciendo: si el tramo ambar domina, las metatx llegan
desordenadas y el buffer las esta sosteniendo; si domina el azul, el cuello de botella es la
cadena.

El boton **`ver tabla`** cambia el grafico por la misma informacion en tabla (para copiar valores).

### Panel "Eventos"

El log estructurado crudo, una linea por evento, con filtro de texto (`relay.sent`, un hash, un
codigo de error) y la casilla **`solo relay.*`** activada por defecto, que esconde el ruido HTTP y
RPC.

### Controles

`usuario` (filtra por `from` cuando hay varios), `pausar` (congela la vista sin cortar el stream) y
`limpiar` (vacia lo mostrado, no el buffer del servidor).

## Ejemplo real: rafaga de 6 metatx

Ejecutado contra el nodo dev (chain 648540, `REORDER_WINDOW_MS=3000`, `MAX_INFLIGHT_PER_USER=16`)
con `npm run test:nonces -- --n 6`. Las 6 metatx salieron simultaneas y llegaron desordenadas:

| # llegada | nonce | `gap` al llegar | retenida | # envio |
|---|---|---|---|---|
| 1 | 72 | 5 | 3302 ms | 6 |
| 2 | 68 | 1 | 1208 ms | 2 |
| 3 | 70 | 3 | 2245 ms | 4 |
| 4 | 67 | — (en turno) | — | 1 |
| 5 | 71 | 4 | 2750 ms | 5 |
| 6 | 69 | 2 | 1694 ms | 3 |

La pagina lo mostro asi: columna de llegada `72, 68, 70, 67, 71, 69`; columna de envio
`67, 68, 69, 70, 71, 72`; **4 reordenadas**, espera media **2.24 s**, 6 minadas, 0 fallidas, en tres
bloques (62029736-38). Es el caso que el relayer en Go resuelve al reves: sin buffer, las cinco que
llegaron adelantadas habrian salido tal cual y el hub habria contestado `BadNonce`, gastando una tx
del writer node por cada una.

## Limites que conviene tener presentes

- **En memoria y por proceso.** Igual que el tracker de nonces. En serverless, cada instancia
  muestra lo suyo y lo que veas depende de a cual haya caido la request (ver "Supuesto: una sola
  instancia" en el README).
- **Sin autenticacion**, como el resto del servicio: el dashboard expone `from`, hashes y montos de
  gas de todas las metatx. No lo publiques sin poner algo delante.
- **Se pierde al reiniciar**: el buffer no se persiste.
- **8 clientes** simultaneos como maximo; el resto recibe `503`.
- Es solo lectura: no toca el camino de la metatx en ningun punto.
