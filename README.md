# ⚽ La Porra Blaugrana

La porra de cada partido del FC Barcelona (temporada 2026-27) para **Rodolfo**, **Eric** y **Dani**.

- Al entrar eliges quién eres (cada uno tiene su caricatura).
- Antes del partido cada uno hace su porra; se puede cambiar hasta el pitido inicial. Las porras de los demás están ocultas hasta que empieza.
- Durante el partido y hasta 4 horas después del final se ve el marcador (en directo desde ESPN), las tres porras y quién va ganando. Después aparece el siguiente partido.
- Siempre hay un ganador: exacto › signo › menos goles de diferencia › diferencia de goles › quien la hizo antes.
- Pestaña **Clasificación**: victorias, exactos, signos acertados e historial de quién ganó cada partido.
- Pestaña **Calendario**: LaLiga, Champions, Copa del Rey y Supercopa.

## Cómo funciona (sin servicios de terceros)

Es una web estática (HTML + JS, sin dependencias) servida por **GitHub Pages**. La "base de datos" son ficheros JSON dentro de este mismo repositorio:

| Fichero | Contenido |
|---|---|
| `data/fixtures.json` | Calendario de partidos |
| `data/results.json` | Resultados |
| `data/porras/<persona>.json` | Las porras de cada uno |

La web escribe en esos ficheros con la API de GitHub usando un token **cifrado** con una contraseña familiar (AES-256 + PBKDF2). Cada persona pone la contraseña una sola vez en su móvil.

Una GitHub Action (`.github/workflows/sync.yml`) consulta cada 30 minutos la API pública de ESPN para actualizar horarios (LaLiga los fija pocas semanas antes), rivales de eliminatorias y resultados finales. Si algo falla, cualquiera puede poner el resultado o editar un partido a mano desde la web.

## Puesta en marcha

1. **Publicar en `main`**: fusiona esta rama en `main`.
2. **Activar GitHub Pages**: *Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `(root)` → Save*. La web quedará en `https://soymachine.github.io/la-porra/`.
3. **Permitir que la Action guarde cambios**: *Settings → Actions → General → Workflow permissions → Read and write permissions → Save*.
4. **Crear el token y la contraseña familiar**: abre `https://soymachine.github.io/la-porra/setup.html` y sigue los pasos. Copia la línea que te da y pégala en `js/config.js` (en lugar de `encryptedToken: null,`).
5. Pasa el enlace y la contraseña a Rodolfo, Eric y Dani. En el móvil: *Compartir → Añadir a pantalla de inicio* para tenerla como una app.

> Nota: el repositorio es público, así que técnicamente las porras se pueden ver en los ficheros JSON antes del partido. Es una porra familiar: confiamos en que nadie haga trampas 😉
