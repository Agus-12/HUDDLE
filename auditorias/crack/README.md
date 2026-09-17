# Crack de libpp_hls.so — emulador Unicorn

Objetivo: obtener el `sign` que la app Movie calcula con su librería nativa
(`libpp_hls.so`), sin teléfono rooteado, para automatizar `info_new` → `vod_url`.

## Qué hay aquí

- `emu_hls.py` — emulador ARM64 (Unicorn) que carga la librería SIN Android,
  aplica sus relocalizaciones, ejecuta su `INIT_ARRAY` y luego `JNI_OnLoad`
  con un `JavaVM`/`JNIEnv` de juguete. Implementa la libc mínima que la lib
  importa (malloc/mmap/uncompress/fopen/…), un `dlsym` falso y un libffi
  reimplementado (la lib trae libffi embebido y lo usa para llamar a Java).
- `bytecode_jni_onload.bin` — bytecode que `JNI_OnLoad` entrega al intérprete
  de la VM (2,904 B, entropía 7.09).

## Uso

```
pip install pyelftools capstone unicorn
python3 emu_hls.py --budget 400        # presupuesto en millones de instrucciones
python3 emu_hls.py --budget 400 --dump # además vuelca la memoria
```

## Hallazgos (verificados, no teoría)

- La librería es una **VM propia**: `INIT_ARRAY[0]` = `0xe7bd8` llama a
  `interpreter_wrap_int64_t` con un blob de 936 B y la sección `.mips`
  (1,532,446 B, entropía 7.9999 = cifrada). No se descomprime con zlib directo.
- El intérprete vive en `0xeff80..0xf2300`: decodifica un **bitstream**
  (campos de 5/6 bits) y despacha por tabla (`br x0` en `0xf0154`).
- Opcodes observados al ejecutar `JNI_OnLoad`: 988 ejecuciones, valores
  `{0,1,2,4,5,6,9,18,19,25,735,959,1074,1187,1683,1692,1700}`.
- Las llamadas a Java pasan por **libffi embebido**: `ffi_prep_cif` +
  `ffi_call(cif, fn, rvalue, avalue)`. Con `cif->abi != 1` la librería real no
  llama a nada (sonda).
- `JNI_OnLoad` (`0xe7c34`) sí llega a ejecutarse y pide `GetEnv` con
  versión `0x10004` (JNI 1.4). Devuelve 0 en vez de `0x10006` y **no llega a
  `RegisterNatives`**: falta que el entorno de juguete satisfaga lo que la VM
  comprueba después de `GetEnv`.

## Estado / siguiente paso

El emulador carga, ejecuta init y entra en `JNI_OnLoad`. Falta completar el
`JNIEnv` de juguete (probablemente `FindClass`/`GetStaticMethodID` sobre una
clase concreta y lectura de campos) para que la VM registre sus métodos
nativos y poder llamar al que calcula el sign. `jni_natives.txt` queda vacío
hasta que eso ocurra.

Alternativa más barata si aparece un Android rooteado: Frida sobre
`/control?msg=verify`.
