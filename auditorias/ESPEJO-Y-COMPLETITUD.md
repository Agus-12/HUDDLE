# EL ESPEJO Y LA «COMPLETITUD» — cuánto de un título se puede ver SIN llave (v229, 19-sep-2026)

Objetivo de este documento: saber **de verdad** qué títulos se pueden ver **completos ahora mismo**
sin la llave del CDN, y dejar la herramienta para volver a medirlo cuando haga falta.

## 1) Cómo se comporta el espejo `147.124.216.142` (medido hoy)

| Petición | Respuesta |
|---|---|
| `/vod/1/2026/09/18/65328ba10998/index5.m3u8` | **200**, 21.243 B (lista completa, 366 pedacitos) |
| `/vod/1/2026/09/18/65328ba10998/0000.ts` | **200**, 646.532 B (el tamaño coincide con su `sz=`) |
| lo mismo **con `range: bytes=0-0`** | **206**, 1 byte ← sirve para medir barato |
| pedacito NO cacheado (p. ej. `0100.ts`, `0180.ts`, `0365.ts`) | **403**, 0 B |
| otro título en otra fecha (`4acbae6998e7` el 02-sep) | **200** con su lista (396 pedacitos) |
| `3605f6781343` (el que estaba completo el 16-sep) | **403 / no está** en las fechas probadas |

Conclusión: el espejo **no firma nada** (no pide llave), pero **solo entrega lo que tiene en caché**.
La caché **cambia por día y por título**: lo que ayer estaba, hoy puede no estar.

## 2) Números reales de «completitud» (19-sep-2026, medido con el medidor nuevo)

| Título | Lista | Pedacitos en caché | Veredicto |
|---|---|---|---|
| `65328ba10998` (fecha 2026/09/18) | index5 | **54 de 366 = 14,8 %** | parcial (faltan 312; huecos en `0064`, `0065`, `0068`…) |
| `4acbae6998e7` (fecha 2026/09/02) | index5 | **98 de 396 = 24,7 %** | parcial (faltan 298) |
| `3605f6781343` | — | 0 | no está en las fechas probadas |

**Esto zanja una duda de la sesión anterior:** el espejo **no** da reproducción completa hoy. Sirve
para tramos (y para comprobar que el reproductor va bien), pero la «película completa» sigue
dependiendo de la **llave del CDN** (o de una caché que coincida al 100 %).

## 3) El medidor (herramienta nueva del repo)

```bash
# en el taller o en Oracle, con internet
python3 scripts/medir-completo-espejo.py 65328ba10998 --fechas 2026/09/18,2026/09/02 --indices 1,5
python3 scripts/medir-completo-espejo.py --ids ids.txt --json /tmp/completo.json
```

Qué hace: pide la lista al espejo, prueba **cada** pedacito con `range: bytes=0-0` (≈1 byte por
prueba, no gasta datos) y devuelve:

- **COMPLETO** (≥ 99,5 % de los pedacitos),
- **parcial** (con el % y los primeros huecos),
- **no está** (esa lista no está en caché ese día).

Detalles técnicos que hay que recordar (costaron una corrida en falso):

1. El espejo contesta **206** a las peticiones por rango (no 200). El medidor acepta 200 y 206.
2. **La fecha importa**: el mismo título vive bajo `…/2026/09/18/…` o `…/2026/09/02/…` según el día
   en que se publicó. Por eso existe `--fechas` (prueba varias y se queda con la que responde).
3. Los pedacitos en la lista vienen como `0000.ts?sz=646532&m8=1e985633a9b58ba4`: `sz` es el
   **tamaño exacto** y `m8` una huella de integridad; al espejo se le pueden pedir **con o sin**
   esos parámetros (las dos formas dan 200 si está en caché).

## 4) Cómo encaja esto en la misión

- **Para Huddle**: el medidor permite marcar cada título como «completo hoy» o «parcial» y **no
  prometer lo que no se puede ver** (regla del usuario: no presentar el catálogo como completo hasta
  que la reproducción funcione).
- **Para la llave**: confirma que el espejo no es una vía de reproducción completa; el objetivo
  sigue siendo firmar (`wsSecret`) para el origen, o reusar los pases capturados mientras duren
  (Vía C del `PLAN-LLAVE-CDN.md`).
- **Para medir más rápido**: si alguna vez se quiere barrer todo el catálogo, hacerlo **en serie y
  con pausas** (el espejo ya dio falsos 0 % en paralelo agresivo).
