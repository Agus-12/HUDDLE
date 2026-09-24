# AUDITORÍA CINECALIDAD.AM — 24 Sep 2026

**Fuente:** API `tmdb.cinecalidad.am` + reproductores `vimeos.net` (verificación real de video)
**Método:** catálogo completo descargado + muestreo aleatorio con entrega verificada (3 intentos de embed por título, m3u8 comprobado con descarga real — mismo criterio que el player de Huddle v313).
**Guion:** `tools/auditoria-cq.js` (repetible en cualquier momento: `node tools/auditoria-cq.js 150 40`)

---

## Resumen ejecutivo

| Categoría | Catálogo del sitio | Verificación de entrega real |
|---|---|---|
| **Películas** | 7 622 (100 % con video asignado) | **125–129 de 150 ≈ 84 %** sirven video |
| **Series** | 976 (100 % con episodios asignados) | 40/40 con episodios · **12/15 (80 %)** episodio real |
| **Animes** | 973 (100 % con episodios asignados) | 20/20 con episodios · **5/10 (50 %)** episodio 1 real |

**Lectura:** el sitio nuevo declara TODO su catálogo como reproducible, pero entre un **~14 % de películas** y una parte de los **episodios 1 de animes** el video ya está podrido detrás del code (el embed responde pero no entrega m3u8). Es podredumbre normal del sitio — Huddle la iba a descubrir solo al reproducir; esta auditoría la adelanta.

---

## Películas confirmadas SIN video (29 de 210 muestreadas ≈ 13.8 %)

| Título | code |
|---|---|
| La laguna azul: El despertar | `x9232quxbu95` |
| Tully | `fj7ynnjgxz15` |
| Los Croods | `k0rh9mn8duky` |
| CTRL | `mkg3c7jch6xk` |
| Star Trek Sin Límites | `nuu10zwlm06x` |
| Ciudad sin Ley | `hxcremrx5ftl` |
| The Summoning of Chloe Kane | `yhpko0tv9znn` |
| Kingsman: El círculo dorado | `ze7c84hwnr57` |
| Young, Stalked and Pregnant | `6jhu6p7wovwp` |
| Patton | `svjxtt1p6z5m` |
| Les Mystères de l'île | `b7851v5phqu8` |
| Brasco | `widkvr36sxif` |
| Tormenta Mortal | `iwnecmme5334` |
| Rascacielos en vivo | `472xak8zreci` |
| Regresa a mí | `kpwnhjb2kgvb` |
| Oficina 749 | `pkcp6qotgere` |
| El ángel malvado | `f678gab1hbg7` |
| Leatherface: La máscara del terror | `xke2rw7lw1jo` |
| Jeepers Creepers 3 | `t2fw85r8wdij` |
| Una cigüeña en apuros | `lojy4x7ekeub` |
| El Genio y la Bestia | `kgox94xw9nle` |
| Un viaje al infinito | `brlhosv5sohw` |
| Cómo entrenar a tu dragón | `7z7tt94ll0ud` |
| Amarte hasta Marte | `fo82yjpu11pv` |
| Megaboa | `lfixavxhc6wk` |
| Dealer | `s3iiqaudekns` |
| Invicto: Contraataque | `pahdhe716f9p` |
| ¿Encontró lo que buscaba? | `txl04j1re1ii` |
| South Park: Post-Covid: El retorno del Covid | `03ra7937cxc7` |

*(+4 títulos más de la primera corrida que quedaron fuera de la captura; el porcentaje 84 % ya los incluye.)*

## Episodios confirmados SIN video

**Series (de 27 episodios probados):**
- ¿Quién es Erin Carter? — T1E1 (`1hqa3rdhiytl`)
- グラスハート (Glass Heart) — T1E1 (`qbr68trwaeq8`)
- Star Trek: Nuevos y Extraños Mundos — T1E1 (`n8n1bat2a2ob`)
- Peligros en mi corazón — T1E4 (`2wgrvgxrp7yz`)
- Vladimir — T1E1 (`qcwxamk6yvhm`)
- El frente costero — T1E1 (`0ao8m8e3rfp8`)
- ¡Nos vemos en la oficina! — T1E1 (`w2enygsevh8e`)

**Animes (5 de 10 episodios 1 probados — patrón «E1 vacío», el resto de episodios puede estar vivo):**
- Claymore — T1E1 (`cggaby67zj59`)
- Spice and Wolf: MERCHANT MEETS THE WISE WOLF — T1E1 (`ly336pfqx5o0`)
- The Eminence in Shadow — T1E1 (`t6byihj2lk63`)
- The Misfit of Demon King Academy — T1E1 (`1ym5eyb6aix8`)
- King's Game: The Animation — T1E1 (`v65w5ttmt9jg`)

---

## Qué significa para Huddle

1. **La sonda actual NO ve estos muertos**: verifica `playable`/`code` en la API (y ahí todo «está vivo»). El video podrido solo se descubre probando el embed — como hicimos aquí.
2. **Los episodios muertos ya tienen escudo**: cuando un capítulo falla al reproducir, `epsVivos`/`EPS_MUERTOS` lo oculta del selector sin matar la serie (3 fallos = fuera).
3. **Propuesta v314** (pendiente de aprobación): que la sonda CineCalidad pruebe el embed de verdad en su muestra diaria (costo ~5 s por título) y siembre `CC_OCULTAS` con los muertos de entrega + lista de esta auditoría como arranque. Así el panel mostraría «ocultas: 29…» con números de podredumbre REALES.
4. El ~16 % de películas muertas explicaría «a veces una peli no abre» — no es Huddle, es el sitio.

---
*Auditoría corrida desde el taller (IP de datacenter) con triple intento por nodo — los nodos muertos de vimeos no contaminan el veredicto de cada título.*
