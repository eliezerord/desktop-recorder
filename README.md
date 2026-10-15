# Desktop Recorder

Graba la pantalla con una burbuja de cámara, o solo la cámara, y guarda un MP4 listo para editar. Solo Windows. Hecha con Electron y ffmpeg.

## Instalar

Desde esta carpeta, una vez:

```bash
npm install
```

Si Electron no baja su programa en la instalación, lo baja solo al primer `npm start`. También se puede forzar con `node node_modules/electron/install.js`.

## Usar

```bash
npm start
```

- Elige qué grabar (pantalla + cámara, o solo cámara), la pantalla, la cámara y el micrófono.
- La cámara virtual de OBS aparece si está encendida en OBS ("Iniciar cámara virtual"). Pulsa Actualizar si no sale.
- Grabar empieza tras una cuenta atrás de 3 segundos. Se puede grabar, pausar y parar desde el panel, desde la pastilla que hay junto a la burbuja, o con los atajos Ctrl+Shift+R (grabar o parar) y Ctrl+Shift+P (pausa).
- Al pasar el ratón por la burbuja sale su barra: quitar cámara, pequeña, mediana y pantalla completa (Esc para salir). Ni la barra ni la pastilla salen en el video.
- Los videos van a `Vídeos\Desktop Recorder\`. Si la conversión a MP4 falla, el WebM original se guarda ahí mismo.

## Probar

```bash
node test/convert-test.js
```

Comprueba la conversión a MP4 sin abrir la app: H.264, tamaño par, 30 fps, audio AAC y progreso.

Prueba completa con la app (abre las ventanas, graba 5 segundos de la pantalla con micrófono y sonido del PC, y cierra sola). Guarda en la carpeta que indiques, no en Vídeos:

```bash
DR_SMOKE=1 DR_OUTPUT_DIR="C:\ruta\temporal" ./node_modules/electron/dist/electron.exe .
```

Comprueba los tamaños de la burbuja, la pantalla completa, la vuelta al tamaño anterior, la posición de la barra y de la pastilla, que el panel se sincroniza y un clic en la barra. Después graba, pausa, reanuda y para con clics en la pastilla. Imprime una línea `SMOKE {...}` con pantallas, cámaras, micrófonos, esas comprobaciones y el archivo guardado. Usa su propia carpeta de ajustes, así que no cambia tus opciones guardadas y puede correr con la app abierta (la cámara saldrá "en uso"). Los clics son simulados dentro de las ventanas: el arrastre y el ratón real solo se prueban a mano.

En Windows, la salida de un proceso que se corta se pierde. Añade `DR_LOG="C:\ruta\smoke.log"` para que los pasos (`SMOKE-STEP`) y los mensajes queden también en un archivo. Añade `DR_DEBUG=1` para ver los mensajes de las ventanas en la terminal.

## Archivos

- `src/main.js` - ventanas, pantalla elegida, sonido del PC, atajos y guardado.
- `src/control.html`, `control.js`, `control.css` - el panel y la grabación.
- `src/bubble-windows.js` - la burbuja y su barra: arrastre, clics a través, tamaños y pantalla completa.
- `src/bubble.html`, `bubble.js` - lo que se ve dentro de la burbuja.
- `src/toolbar.html`, `toolbar.js` - la barra de controles que sale al pasar el ratón (no sale en el video).
- `src/recpill.html`, `recpill.js` - la pastilla de grabar, pausar y parar junto a la burbuja (no sale en el video).
- `src/convert.js` - WebM a MP4 con ffmpeg.
- `src/preload.js` - las llamadas que las ventanas pueden hacer al proceso principal.
