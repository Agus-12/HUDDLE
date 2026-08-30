# Guía: Huddle gratis en Oracle Cloud

> **Qué vas a lograr:** tu propio Huddle — salas de video con espejos,
> funcionando 24/7 en internet, **gratis**, con capacidad para
> **8 espejos simultáneos** y espectadores ilimitados. Sin depender de tu
> Mac ni de tu internet.
>
> **Tiempo total:** ~35-45 min (en 5 partes cortas).
>
> **Qué necesitas:** tu Mac, una tarjeta (de preferencia crédito) para
> verificar la cuenta de Oracle (no se cobra nada), y esta guía.
>
> **Tu código ya está en GitHub** (yo lo subí):
> **`https://github.com/Agus-12/HUDDLE`**

---

## PARTE 1 — Crear tu cuenta Oracle (10-15 min)

1. Entra a **oracle.com/cloud/free** → botón **"Start for free" / "Comenzar gratis"**.
2. Llena: país **México**, tu nombre y correo. Te enviarán un código al correo.
3. Crea una **contraseña fuerte** (te exige mayúsculas, número y símbolo).
4. Verificación por **SMS** al celular.
5. **Tarjeta:** Oracle hace una verificación temporal (~1 USD que desaparece
   a los días). **No se cobra nada** en el plan gratuito.
   - ⚠️ Algunas tarjetas de **débito** las rechaza; si falla, usa una de crédito.
6. **Región:** elige una de EE.UU. (recomiendo **US East (Ashburn)**).
   ⚠️ La región NO se puede cambiar después, pero cualquiera de EE.UU. sirve.

## PARTE 2 — Crear la máquina virtual (10 min)

1. Entra a **cloud.oracle.com** (inicia sesión) → menú **☰** (arriba izquierda)
   → **Compute** → **Instances** → botón **Create instance**.
2. **Name:** `huddle`.
3. Sección **Image and Shape** → **Edit**:
   - **Imagen:** clic en **Edit / Change image** → elige **Canonical Ubuntu 24.04**
     (no Oracle Linux). Acepta el aviso que salga.
   - **Forma (Shape):** clic en **Change shape** → selecciona **Ampere** (A1.Flex):
     - OCPUs: **2**
     - Memory: **12 GB**
   - Confirma. *(Esto es la máquina gratis: 2 núcleos y 12 GB sin costo)*
4. Sección **SSH keys** → marca **Generate a key pair**:
   - **Save Private Key** → se guarda en tus Descargas (ej. `ssh-key-2026-...key`)
   - **Save Public Key** → igual a Descargas.
   - ⚠️ No pierdas el archivo .key: es la llave para entrar a tu servidor.
5. Boot volume: déjalo como está → **Create**.
6. Espera ~1 min a que quede **RUNNING** y anota la **Public IP Address**
   (ej. `140.238.10.20`). Es la dirección de tu servidor.

> ⚠️ Si sale **"Out of capacity"**: es MUY común ahora en todas las regiones.
> Solución en orden:
> 1. Clic en **Create** de nuevo, varias veces (a veces cae una máquina libre)
> 2. Cambia la zona de disponibilidad (Availability Domain) y reintenta
> 3. **La solución definitiva:** actualiza tu cuenta a **Pay As You Go**
>    (menú → Billing). Sigue siendo 100% gratis mientras te mantengas en
>    2 OCPU/12GB — PAYG solo cobra si te PASAS de los límites gratis.
>    Con PAYG el error "out of capacity" desaparece casi siempre.

## PARTE 3 — Abrir el puerto 3000 (5 min)

*(Para que el mundo pueda ver tu app, Oracle pide abrirle una "puerta")*

1. En la página de tu instancia, en **Instance information**, haz clic en el
   nombre de la **VCN** (el enlace azul).
2. En el menú izquierdo, **Security Lists** → entra a la
   **Default Security List for ...**.
3. **Add Ingress Rules** y llena exactamente:
   - Source Type: CIDR
   - Source CIDR: `0.0.0.0/0`
   - IP Protocol: `TCP`
   - Destination Port Range: `3000`
4. **Add Ingress Rules** (botón abajo). Listo.

## PARTE 4 — Instalar todo (10 min, solo copiar y pegar)

1. En tu Mac: **Cmd + Espacio** → escribe **Terminal** → Enter.
2. Pega esta línea y Enter (habilita tu llave):

   ```
   chmod 400 ~/Downloads/ssh-key-*.key
   ```

3. Conéctate a tu servidor (cambia `TU-IP` por la Public IP de la Parte 2):

   ```
   ssh -i ~/Downloads/ssh-key-*.key ubuntu@TU-IP
   ```

   Si pregunta *"Are you sure you want to continue connecting"* → escribe `yes` + Enter.

4. Ya dentro (verás el prompt `ubuntu@huddle:~$`), pega esto tal cual:

   ```
   git clone https://github.com/Agus-12/HUDDLE.git
   cd HUDDLE
   sudo bash deploy/oracle/setup-oracle.sh
   ```

5. Espera **5-8 minutos** mientras instala Chrome, Node, audio, etc.
   Al final imprime un recuadro con **el enlace de tu app**: `http://TU-IP:3000`

## PARTE 5 — Probar

1. Abre `http://TU-IP:3000` en tu Mac.
2. Prueba definitiva: ábrelo **también en tu celular con datos móviles**
   (WiFi apagado). Si carga desde tu celular, todo el mundo puede entrar.
3. Crea una sala, comparte el enlace/código con tus amigos y prueba un espejo.

---

## Si algo falla

Copia y pega estos comandos en la Terminal (conectado a tu servidor) y
**pásame lo que imprima**:

```
sudo journalctl -u huddle -n 50 --no-pager
systemctl status xvfb pulse huddle --no-pager
```

**Casos comunes:**
| Problema | Solución |
|---|---|
| "Out of capacity" al crear máquina | Reintentar el Create; cambiar Availability Domain |
| Tarjeta rechazada | Probar con tarjeta de crédito (no débito) |
| La app no abre desde fuera | Revisar Ingress Rule puerto 3000 (Parte 3) |
| Algo se descompuso | `sudo systemctl restart huddle` (o avísame) |

## Cómo se mantiene viva

- Los servicios se **auto-reinician** si algo falla y **arrancan solos** si
  Oracle reinicia la máquina. No hay que hacer nada.
- Oracle puede **pausar** máquinas gratuitas que estén semanas sin usarse:
  si tu enlace deja de funcionar, entra a cloud.oracle.com → Compute →
  Instances → botón **Start**, y listo (nada se pierde).
- **Actualizar la app** (cuando haya cambios nuevos en GitHub): conéctate por
  SSH como en la Parte 4 y ejecuta:
  ```
  cd ~/huddle && bash actualizar.sh
  ```
  Descarga la versión nueva y reinicia (~20 segundos). Quienes estén
  conectados verán su navegador recargarse solo con la nueva versión.
