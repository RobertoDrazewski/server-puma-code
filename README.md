# Estación Puma · server.puma-code.com

Panel steampunk de monitoreo y control del servidor de **Puma Code**.
Descubre solos los proyectos que despliegas en Coolify, vigila que estén en línea, mide CPU/RAM/red/disco por proyecto (y quién consume más), tiene terminal web y un "ingeniero de a bordo" que te da el informe hablado al entrar y te pregunta por pendientes al apagar.

Product manager R.D by Puma-Code

## Qué hace

- **Autodescubrimiento**: lee los contenedores por la API de Docker (etiquetas de Coolify). Un proyecto nuevo aparece solo, sin tocar nada.
- **Uptime**: chequea cada sitio (hosts de Traefik + `EXTRA_URLS`) cada 60 s, latencia, % 24 h y vencimiento del certificado TLS.
- **KPIs por proyecto**: CPU, memoria, red, sparkline, historial 1 h / 24 h / 7 d, insignia "#1 consumo".
- **Alertas** en el registro de a bordo: proyecto caído, sitio sin respuesta, certificado por vencer, CPU/RAM/disco altos.
- **Orquestador (opcional, OpenAI)**: informe de bienvenida hablado que te identifica (Roberto / Mauro) y cierre de jornada que guarda pendientes y trabajos para mañana. Sin API key funciona igual con texto de plantilla, costo cero.
- **Roles**: `ADMIN_EMAILS` (todo: reiniciar contenedores, terminal) y `VIEWER_EMAILS` (solo lectura).
- **Terminal web** (solo admin, desactivada por defecto).

## Probar en tu computadora (datos REALES de tu Docker)

Requiere Node 22+ y Docker corriendo.

```bash
npm install
cp .env.example .env      # editá ADMIN_EMAILS (tu correo primero) y BOOTSTRAP_PASSWORD
npm run local
```

Abrí http://localhost:3000 → **Acceso** → tu correo y la clave inicial; te pide cambiarla. Lee tu Docker real (detecta el socket solo) y la terminal abre un shell de tu propia máquina. Escucha solo en `127.0.0.1`.

`npm run demo` levanta un Docker simulado (solo para ver la interfaz sin Docker).

## Acceso y usuarios

- Login propio con correo + clave (scrypt), sesión en cookie HttpOnly/SameSite, bloqueo tras 6 intentos fallidos.
- **Superadmin** (primer correo de `ADMIN_EMAILS`): menú ☰ → **Accesos** para crear usuarios, cambiar roles, resetear claves, desactivar o borrar, y ver la auditoría. **Admin**: reinicia contenedores y usa la terminal. **Solo lectura**: métricas y logs.
- Cada usuario sube su foto y cambia su clave en **Mi perfil**.
- Los correos de `ADMIN_EMAILS`/`VIEWER_EMAILS` se crean solos al arrancar; después se gestionan desde Accesos.
- El botón **Cierre de jornada** no apaga ningún servidor: solo cierra tu sesión del panel (después de las preguntas de cierre).

## Despliegue en el VPS con Coolify (producción)

1. **Cloudflare DNS**: registro `server` → IP del VPS (proxy naranja).
2. **Coolify → Nuevo recurso → Docker Compose** desde este repo (`RobertoDrazewski/server-puma-code`, rama `main`).
   - En el servicio `station`: dominio `https://server.puma-code.com`, puerto 3000.
   - Variables (`.env.example`): `ADMIN_EMAILS`, `BOOTSTRAP_PASSWORD` (una clave temporal fuerte), y si querés `OPENAI_API_KEY`.
3. Deploy. `https://server.puma-code.com/healthz` responde sin login; el resto exige acceso.
4. Entrá, cambiá tu clave y creá/ajustá el acceso de Mauro en **Accesos**. Después podés borrar `BOOTSTRAP_PASSWORD`.
5. Opcional: Cloudflare Zero Trust → Access para `server.puma-code.com` y cargar `CF_ACCESS_TEAM_DOMAIN` y `CF_ACCESS_AUD`; queda como segunda capa.

### Variables

| Variable | Para qué |
|---|---|
| `ADMIN_EMAILS`, `VIEWER_EMAILS`, `BOOTSTRAP_PASSWORD` | Accesos iniciales (ver arriba) |
| `OPENAI_API_KEY`, `OPENAI_MODEL`, `AI_DAILY_CALLS` | Orquestador. Modelo barato (`gpt-4o-mini`), tope de 20 llamadas/día y caché de 10 min. La key solo como variable en Coolify |
| `EXTRA_URLS` | Sitios extra a vigilar, separados por coma: `https://sitio.com` o `proyecto=https://sitio.com`. Los dominios de Coolify se descubren solos |
| `TERMINAL_ENABLED` | `0` para desactivar la terminal |
| `GROUPS_FILE` | JSON opcional para agrupar proyectos (ver `config/groups.example.json`) |
| `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | Capa extra opcional de Cloudflare Access |

## Terminal en el VPS

La terminal del panel entra por SSH al propio servidor con un usuario **sin privilegios** (`estacion`), nunca como root.

1. Entrá al panel como superadmin; si falta el usuario, la terminal te muestra el comando exacto con tu clave pública.
2. En el VPS: `sudo bash crear-usuario-estacion.sh "<clave pública>"` (el script está en `scripts/`).
3. Permití SSH desde la red de Docker (lo explica el script al final) y `sudo systemctl reload ssh`.
4. Reconectá desde el panel. Cada línea tipeada queda auditada; una sesión por usuario y cierre a los 15 min sin uso.

## Seguridad

- Login propio + (opcional) Cloudflare Access. Sin sesión, la API responde 401.
- La app **no** toca `docker.sock`: habla con `socket-proxy` (contenedores, info y reinicio; sin crear ni borrar).
- Origen verificado en pedidos que modifican datos, cabeceras CSP, auditoría de acciones de admin.
- Datos en el volumen `/data` (SQLite, retención 7 días).

## Volver atrás

Quitá el dominio del recurso en Coolify y la estación deja de ser accesible. No modifica tus proyectos.

## Estructura

```
src/       servidor (Express, colector, usuarios, orquestador, terminal)
public/    interfaz y recursos gráficos
dev/       Docker simulado para la demo
scripts/   preparación del servidor
```
