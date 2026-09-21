# Tailscale — Setup rápido (5 minutos)

Tailscale conecta tu Mac Mini y el servidor Oracle como si estuvieran en la misma red local. Sin abrir puertos, sin túneles, sin cambios de IP.

## Paso 1: Instalar en Mac Mini
```bash
brew install tailscale
sudo tailscaled install-system-daemon
tailscale up
```
Te pide login (Google/Microsoft/GitHub). Anota la IP que te dé (algo como `100.x.x.x`).

## Paso 2: Instalar en servidor Oracle
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```
Mismo login. Anota su IP Tailscale.

## Paso 3: Verificar conexión
Desde el servidor Oracle:
```bash
ping <IP-Tailscale-del-Mac>
```
Si responde, ¡ya están conectados!

## Paso 4: Iniciar relay en Mac Mini
```bash
node ~/relay.js
```

## Paso 5: Configurar relay en servidor
```bash
curl 'http://localhost:3000/api/set-relay?url=http://<IP-Tailscale-del-Mac>:3128'
```

## Paso 6: Verificar
```bash
curl 'http://localhost:3000/api/health'
# Debe mostrar cdnRelay: "http://100.x.x.x:3128"

# Probar Marfil
curl -s 'http://localhost:3000/api/solo?name=TEST&tok=TOKEN&url=https://cuevana.mov/pelicula/83857/enfrentados-marfil'
```

## Para que arranque automático al reiniciar Mac
```bash
# En Mac Mini, crear launchd plist:
cat > ~/Library/LaunchAgents/com.huddle.relay.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.huddle.relay</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/local/bin/node</string>
        <string>/Users/macmini/relay.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/Users/macmini/relay.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/macmini/relay.log</string>
</dict>
</plist>
EOF
launchctl load ~/Library/LaunchAgents/com.huddle.relay.plist
```

## Notas
- Tailscale es gratis para uso personal (hasta 100 dispositivos)
- La IP Tailscale (`100.x.x.x`) es estable y no cambia
- No necesita abrir puertos en el router
- La conexión es directa (P2P) cuando es posible, o vía relay de Tailscale
- El relay.js en Mac Mini escucha en `127.0.0.1:3128` — necesitamos cambiarlo a `0.0.0.0:3128` para que Tailscale pueda llegar