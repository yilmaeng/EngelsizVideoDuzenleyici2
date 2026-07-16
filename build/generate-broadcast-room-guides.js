const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'website', 'guides');
fs.mkdirSync(outputDir, { recursive: true });

const sourceTr = path.join(root, 'docs', 'evd-yayin-odasi-kullanim-kilavuzu.html');
fs.copyFileSync(sourceTr, path.join(outputDir, 'evd-yayin-odasi-kullanim-kilavuzu.html'));

const css = `
    :root { --text:#1f2937; --muted:#4b5563; --accent:#0f766e; --line:#d1d5db; --soft:#f3f4f6; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Segoe UI", Arial, sans-serif; color: var(--text); line-height: 1.55; background: white; }
    .page { max-width: 920px; margin: 0 auto; padding: 40px 52px 72px; }
    h1, h2, h3 { line-height: 1.25; margin: 0 0 14px; }
    h1 { font-size: 30px; color: #0b3b36; margin-bottom: 10px; }
    h2 { font-size: 22px; color: var(--accent); margin-top: 34px; padding-top: 14px; border-top: 2px solid var(--line); }
    h3 { font-size: 17px; margin-top: 20px; }
    p, li { font-size: 14px; }
    p { margin: 0 0 12px; }
    ul, ol { margin: 0 0 14px 22px; padding: 0; }
    li { margin: 0 0 7px; }
    .lead { font-size: 16px; color: var(--muted); margin-bottom: 18px; }
    .meta { display: flex; gap: 18px; flex-wrap: wrap; padding: 12px 16px; background: var(--soft); border: 1px solid var(--line); border-radius: 10px; margin-bottom: 28px; }
    .meta span { font-size: 13px; color: var(--muted); }
    .toc { background: #f8fafc; border: 1px solid var(--line); border-radius: 10px; padding: 18px 20px; margin-bottom: 28px; }
    .toc h2 { border: 0; padding-top: 0; margin-top: 0; font-size: 18px; }
    .toc a { color: var(--accent); text-decoration: none; }
    .toc a:hover, .toc a:focus { text-decoration: underline; }
    .note, .tip { border-left: 4px solid var(--accent); background: #f0fdfa; padding: 12px 14px; margin: 14px 0 18px; border-radius: 8px; }
    .note strong, .tip strong { color: #115e59; }
    .shortcut-list li { margin-bottom: 6px; }
    .footer { margin-top: 44px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
    @media print { .page { max-width: none; padding: 20mm 16mm 18mm; } a { color: inherit; text-decoration: none; } }
`;

const guides = {
  en: {
    file: 'evd-broadcast-room-user-guide.html',
    title: 'EVD Broadcast Room User Guide',
    lead: 'This guide explains the EVD Broadcast Room workflow for accessible and professional livestreams, meetings, interviews, recordings, screen sharing, live captions, translation, dubbing, participant management, and scene design.',
    product: 'Accessible Video Editor',
    section: 'Broadcast Room',
    docType: 'Shareable HTML/PDF guide',
    updated: 'June 13, 2026',
    toc: 'Contents',
    footer: 'This document is the shareable guide for the EVD Broadcast Room help content.',
    sections: [
      ['What is the Broadcast Room?', ['The Broadcast Room is a live production workspace where you invite guests with a link, receive their camera, microphone, and screen share, and send the composed scene to recording or YouTube.', 'The workflow has two layers: first you create or open the room, then you decide how people and shared content appear on stage.'], ['Temporary and persistent rooms', 'Guest camera, microphone, chat, screen sharing, and participant commands', 'Manual scene layouts, background profiles, logos, live captions, translation, sign-language interpreter placement, recording, YouTube, and effects']],
      ['Interface Overview', ['Use Alt+L to open the region list. Move with the arrow keys and press Enter to jump to the selected area. Ctrl+Right and Ctrl+Left move quickly between main regions.'], ['Room and devices', 'Participants and chat', 'Sharing and sources', 'Scene layout', 'Backgrounds', 'OBS, recording, YouTube, effects', 'Live captions and translation', 'Diagnostics and event history']],
      ['Opening Temporary or Persistent Rooms', ['Use the room controls to create a quick temporary room, or open Room Management with Alt+O to create a persistent room. Persistent rooms can have a custom link key, password rules, and host-absent joining rules.', 'The persistent room list supports arrow-key navigation, Enter to open a room, and Right Arrow to open the context menu.']],
      ['Guest Join Page', ['The guest page is intentionally simple. Device choices are inside the Device options panel; the main flow is display name, optional password, and Join Room.'], ['Microphone: Ctrl+D', 'Camera: Ctrl+E', 'Start or stop sharing: Ctrl+Shift+E', 'Leave room: Ctrl+Shift+H', 'Chat, participants, other information, captions, and accessible share text are kept in collapsible panels to reduce clutter.']],
      ['Scene Layouts', ['Scene layouts control how the host, guests, and shares appear in the recording or livestream. You can assign people, cameras, and shares to slots manually with the slot assignment menu.', 'When a share starts, EVD can keep speakers as small windows and return to the previous layout when sharing stops.']],
      ['Backgrounds, Logo, and Profiles', ['You can add JPG, PNG, WebP, BMP, MP4, WebM, MOV, or MKV backgrounds. If the file is not suitable for 1920x1080, EVD can warn you or create a converted copy.', 'Background profiles store background, fit mode, darkening, logo file, logo position, and logo size for repeated use.']],
      ['Recording', ['Press Alt+R or use the recording button after OBS and the scene are ready. Recording uses a clean Broadcast Output window so the host control interface does not appear in the final video.', 'Return to the Broadcast Room window to change layouts, manage guests, trigger effects, share the screen, or stop recording.']],
      ['Guest Local Backup and Bot Recording', ['During local recording, supported guest browsers can create local backup audio or video chunks. If the main recording has network freezes, the host can later replace affected parts with cleaner guest backups.', 'Bot recording is optional and can be toggled with Alt+Ctrl+B. It is a safety tool for special workflows, not the default recording method.']],
      ['YouTube Livestreaming', ['Prepare the scene and OBS, choose or create the YouTube stream, then start or stop the livestream with Alt+Ctrl+L. A private or unlisted test stream is strongly recommended before a real event.', 'Emergency stop is available if the interface becomes hard to control during a live stream.']],
      ['Live Captions, Translation, and Dubbing', ['Enable Live translation/captions, choose the service, source language, target language, and output mode. OpenAI is recommended for text captions and translation; Gemini Live Translate is recommended for spoken translation; ElevenLabs is useful especially for post-recording dubbing.', 'Guests choose their own language in the captions/translation panel. If speech is already in the guest target language, the same-language translation voice is not played back.']],
      ['Post-recording ElevenLabs Dubbing', ['After recording, you can send the file to ElevenLabs Dubbing and create a dubbed MP4. EVD can mix the dubbed voice in front with the original audio underneath.', 'Stored dubbing segments can be remixed without sending the same job again, which saves time and credits.']],
      ['API Keys and AI Services', ['API keys are managed from the AI menu. Gemini is used for visual feedback and Gemini Live Translate. OpenAI is used for text translation/transcription and can be a fallback for AI scene feedback. ElevenLabs is used for Scribe, voices, and post-recording dubbing.']],
      ['Effects Layer', ['The effects layer lets you trigger jingles, sounds, videos, and visual effects during recording or livestreaming. Effects are sent to the final output.']],
      ['Screen Sharing', ['Host sharing is opened with Alt+S. Choose full screen, window, or an available local source, and optionally include system audio. Guest sharing uses the browser share picker.', 'Accessible document sharing lets you upload the related PowerPoint, Word, or supported file so blind guests can follow the slide or document text instead of receiving only a visual image.']],
      ['Participant Management and Chat', ['Open the participant list with Alt+U. Move with Up and Down, open the selected participant menu with Right Arrow, and close it with Left Arrow or Escape.', 'The menu includes remove from room, message, mute/unmute, camera/video permissions, screen-share permission, panelist role, interpreter roles, and speaking request handling.']],
      ['Webinar Flow', ['Webinar mode is for large audiences where only selected panelists appear or speak. Users can request a webinar, admins can approve it, and the host can receive a webinar key. Time limits, audience rules, and persistent webinar options can be configured.']],
      ['AI Scene Feedback', ['The Ask AI for feedback button analyzes the real scene frame and reports whether faces are visible, sharing is placed correctly, black gaps exist, or unwanted controls appear. Gemini is preferred first; OpenAI can be used as a fallback when available.']],
      ['Main Shortcuts', ['Host: Alt+A microphone, Alt+V camera, Alt+S sharing, Alt+Y layout, Alt+U participants, Alt+C chat, Alt+O room management, Alt+Q leave/end room, Alt+R recording, Alt+L region list, Alt+Ctrl+L YouTube, Alt+Ctrl+B bot recording, Alt+Ctrl+T live captions/translation.', 'Guest web: Ctrl+D microphone, Ctrl+E camera, Ctrl+Shift+E sharing, Ctrl+Shift+H leave room.']],
      ['Troubleshooting', ['If a guest has no audio, check browser permissions and selected devices. If sharing has no audio, verify that the browser provides audio for the selected share type. If captions or translation do not start, check the feature checkbox and API key status.', 'Use Diagnostics and Event History first when investigating share audio, video tracks, participant events, or YouTube/recording behavior.']]
    ]
  },
  de: {
    file: 'evd-broadcast-room-benutzerhandbuch.html',
    title: 'EVD Broadcast-Raum Benutzerhandbuch',
    lead: 'Dieses Handbuch erklärt den EVD Broadcast-Raum für barrierefreie und professionelle Livestreams, Besprechungen, Interviews, Aufnahmen, Bildschirmfreigabe, Live-Untertitel, Übersetzung, Dubbing, Teilnehmerverwaltung und Szenengestaltung.',
    product: 'Barrierefreier Videoeditor',
    section: 'Broadcast-Raum',
    docType: 'Teilbares HTML/PDF-Handbuch',
    updated: '13. Juni 2026',
    toc: 'Inhalt',
    footer: 'Dieses Dokument ist die teilbare Anleitung zum Hilfebereich des EVD Broadcast-Raums.',
    sections: [
      ['Was ist der Broadcast-Raum?', ['Der Broadcast-Raum ist ein Produktionsbereich, in dem Sie Gäste per Link einladen, Kamera, Mikrofon und Bildschirmfreigabe empfangen und die fertige Szene an Aufnahme oder YouTube senden.', 'Der Ablauf hat zwei Ebenen: zuerst Raum öffnen, danach festlegen, wie Personen und Inhalte auf der Bühne erscheinen.'], ['Temporäre und permanente Räume', 'Kamera, Mikrofon, Chat, Bildschirmfreigabe und Teilnehmerbefehle', 'Manuelle Szenenlayouts, Hintergründe, Logos, Live-Untertitel, Übersetzung, Gebärdensprachdolmetscher, Aufnahme, YouTube und Effekte']],
      ['Oberfläche', ['Alt+L öffnet die Bereichsliste. Mit Pfeilen navigieren Sie, Enter springt in den gewählten Bereich. Ctrl+Rechts und Ctrl+Links wechseln schnell zwischen Hauptbereichen.'], ['Raum und Geräte', 'Teilnehmer und Chat', 'Freigabe und Quellen', 'Szenenlayout', 'Hintergründe', 'OBS, Aufnahme, YouTube, Effekte', 'Live-Untertitel und Übersetzung', 'Diagnose und Ereignisverlauf']],
      ['Temporäre oder permanente Räume öffnen', ['Erstellen Sie schnell einen temporären Raum oder öffnen Sie die Raumverwaltung mit Alt+O, um einen permanenten Raum anzulegen. Permanente Räume unterstützen eigene Linkschlüssel, Kennwortregeln und Beitritt ohne Host.', 'Die Liste permanenter Räume kann mit Pfeiltasten, Enter und Rechts-Pfeil für das Kontextmenü bedient werden.']],
      ['Gast-Beitrittsseite', ['Die Gastseite ist bewusst einfach. Geräteauswahl befindet sich im Bereich Geräteoptionen; der normale Ablauf ist Anzeigename, optionales Kennwort und Raum beitreten.'], ['Mikrofon: Ctrl+D', 'Kamera: Ctrl+E', 'Freigabe starten/stoppen: Ctrl+Shift+E', 'Raum verlassen: Ctrl+Shift+H', 'Chat, Teilnehmer, weitere Informationen, Untertitel und zugänglicher Freigabetext liegen in einklappbaren Bereichen.']],
      ['Szenenlayouts', ['Layouts bestimmen, wie Host, Gäste und Freigaben in Aufnahme oder Livestream erscheinen. Quellen können über das Slot-Zuweisungsmenü manuell platziert werden.', 'Bei Bildschirmfreigabe kann EVD Sprecher als kleine Fenster behalten und nach Ende der Freigabe zum vorherigen Layout zurückkehren.']],
      ['Hintergründe, Logo und Profile', ['Sie können JPG, PNG, WebP, BMP, MP4, WebM, MOV oder MKV als Hintergrund verwenden. Bei ungeeigneter Größe kann EVD warnen oder eine 1920x1080-Kopie erstellen.', 'Profile speichern Hintergrund, Anpassung, Abdunklung, Logo, Position und Größe.']],
      ['Aufnahme', ['Starten Sie mit Alt+R, nachdem OBS und Szene bereit sind. Die Aufnahme verwendet ein sauberes Sendeausgabe-Fenster, damit die Steueroberfläche nicht im Video erscheint.', 'Für Layout, Gäste, Effekte, Freigabe oder Stopp kehren Sie zum Broadcast-Raum-Fenster zurück.']],
      ['Lokales Gast-Backup und Bot-Aufnahme', ['Während lokaler Aufnahme können unterstützte Gastbrowser lokale Backup-Stücke erstellen. Bei Netzwerkaussetzern können diese später als sauberere Quelle genutzt werden.', 'Bot-Aufnahme ist optional und wird mit Alt+Ctrl+B umgeschaltet.']],
      ['YouTube-Livestream', ['Bereiten Sie Szene und OBS vor, wählen oder erstellen Sie den Stream und starten/stoppen Sie mit Alt+Ctrl+L. Ein privater Teststream wird empfohlen.', 'Ein Not-Stopp ist verfügbar, falls die Oberfläche während des Livestreams schwer bedienbar wird.']],
      ['Live-Untertitel, Übersetzung und Dubbing', ['Aktivieren Sie Live-Übersetzung/Untertitel und wählen Sie Dienst, Quell- und Zielsprache sowie Ausgabe. OpenAI eignet sich für Text, Gemini Live Translate für gesprochene Übersetzung, ElevenLabs besonders für Dubbing nach der Aufnahme.', 'Gäste wählen ihre Sprache im Panel. Wenn bereits in der Zielsprache gesprochen wird, wird keine gleichsprachige Übersetzungsstimme abgespielt.']],
      ['ElevenLabs-Dubbing nach der Aufnahme', ['Nach der Aufnahme kann die Datei an ElevenLabs Dubbing gesendet werden. EVD mischt die Dub-Stimme vorne und den Originalton darunter.', 'Gespeicherte Segmente können ohne erneute API-Anfrage neu gemischt werden.']],
      ['API-Schlüssel und KI-Dienste', ['API-Schlüssel werden im KI-Menü verwaltet. Gemini dient für visuelles Feedback und Live Translate, OpenAI für Textübersetzung/Transkription und als Fallback, ElevenLabs für Scribe, Stimmen und Dubbing.']],
      ['Effekt-Ebene', ['Die Effekt-Ebene triggert Jingles, Sounds, Videos und visuelle Effekte während Aufnahme oder Livestream. Effekte gehen in die Ausgabe.']],
      ['Bildschirmfreigabe', ['Host-Freigabe: Alt+S. Wählen Sie Bildschirm, Fenster oder Quelle und optional Systemton. Gäste verwenden den Browserdialog.', 'Mit zugänglicher Dokumentfreigabe kann eine passende PowerPoint-, Word- oder unterstützte Datei hochgeladen werden, damit blinde Gäste Text und Folien verfolgen können.']],
      ['Teilnehmerverwaltung und Chat', ['Alt+U öffnet die Teilnehmerliste. Pfeile bewegen, Rechts-Pfeil öffnet das Menü, Links-Pfeil oder Escape schließt es.', 'Das Menü enthält Entfernen, Nachricht, Stumm, Kamera/Video, Freigaberechte, Panelist, Dolmetscherrollen und Wortmeldungen.']],
      ['Webinar-Ablauf', ['Webinar-Modus ist für große Gruppen, bei denen nur ausgewählte Panelisten sprechen oder erscheinen. Anfragen können von Admins bestätigt und mit Webinar-Schlüssel an Hosts gegeben werden.']],
      ['KI-Szenenfeedback', ['KI-Feedback analysiert den realen Szenenframe und meldet sichtbare Gesichter, Freigabeplatzierung, schwarze Bereiche oder unerwünschte Bedienelemente. Gemini wird bevorzugt, OpenAI kann als Fallback dienen.']],
      ['Wichtige Tastenkürzel', ['Host: Alt+A Mikrofon, Alt+V Kamera, Alt+S Freigabe, Alt+Y Layout, Alt+U Teilnehmer, Alt+C Chat, Alt+O Raumverwaltung, Alt+Q verlassen/beenden, Alt+R Aufnahme, Alt+L Bereiche, Alt+Ctrl+L YouTube, Alt+Ctrl+B Bot-Aufnahme, Alt+Ctrl+T Untertitel/Übersetzung.', 'Gast: Ctrl+D Mikrofon, Ctrl+E Kamera, Ctrl+Shift+E Freigabe, Ctrl+Shift+H verlassen.']],
      ['Fehlerbehebung', ['Bei fehlendem Gastton prüfen Sie Berechtigungen und Geräte. Bei fehlendem Freigabeton prüfen Sie, ob der Browser Ton für die gewählte Quelle liefert. Bei Untertitelproblemen prüfen Sie Aktivierung und API-Schlüssel.', 'Diagnose und Ereignisverlauf sind die erste Anlaufstelle für Ton, Video, Teilnehmer und YouTube/Aufnahme.']]
    ]
  },
  es: {
    file: 'guia-sala-transmision-evd.html',
    title: 'Guía de la Sala de transmisión de EVD',
    lead: 'Esta guía explica la Sala de transmisión de EVD para directos, reuniones, entrevistas, grabaciones, pantalla compartida, subtítulos, traducción, doblaje, gestión de participantes y diseño de escena con accesibilidad.',
    product: 'Editor de Video Accesible',
    section: 'Sala de transmisión',
    docType: 'Guía HTML/PDF compartible',
    updated: '13 de junio de 2026',
    toc: 'Contenido',
    footer: 'Este documento es la guía compartible del contenido de ayuda de la Sala de transmisión de EVD.',
    sections: [
      ['¿Qué es la Sala de transmisión?', ['Es un espacio de producción donde invita a personas con un enlace, recibe cámara, micrófono y pantalla, y envía la escena compuesta a grabación o YouTube.', 'Primero se abre la sala; después se decide cómo se ven las personas y contenidos en la escena.'], ['Salas temporales y persistentes', 'Cámara, micrófono, chat, pantalla compartida y comandos de participantes', 'Diseños manuales, fondos, logos, subtítulos, traducción, intérprete de lengua de señas, grabación, YouTube y efectos']],
      ['Resumen de la interfaz', ['Alt+L abre la lista de regiones. Use flechas y Enter para saltar. Ctrl+Derecha y Ctrl+Izquierda cambian rápidamente de región.'], ['Sala y dispositivos', 'Participantes y chat', 'Compartir y fuentes', 'Diseño de escena', 'Fondos', 'OBS, grabación, YouTube, efectos', 'Subtítulos y traducción', 'Diagnóstico e historial']],
      ['Abrir salas temporales o persistentes', ['Cree una sala temporal o abra Gestión de sala con Alt+O para una sala persistente. Puede definir clave del enlace, contraseña y reglas cuando el anfitrión no esté.', 'La lista se maneja con flechas, Enter y Flecha derecha para el menú.']],
      ['Página de invitado', ['La página de invitado es simple. Las opciones de dispositivos están en un panel plegable; el flujo principal es nombre, contraseña opcional y Unirse.'], ['Micrófono: Ctrl+D', 'Cámara: Ctrl+E', 'Compartir: Ctrl+Shift+E', 'Salir: Ctrl+Shift+H', 'Chat, participantes, información, subtítulos y texto accesible están en paneles plegables.']],
      ['Diseños de escena', ['Definen cómo aparecen anfitrión, invitados y pantallas en la grabación o directo. Puede asignar fuentes manualmente a cada espacio.', 'Al compartir pantalla, EVD puede mantener los rostros como ventanas pequeñas y volver al diseño anterior al terminar.']],
      ['Fondos, logo y perfiles', ['Puede usar JPG, PNG, WebP, BMP, MP4, WebM, MOV o MKV. Si no es 1920x1080, EVD puede avisar o crear una copia convertida.', 'Los perfiles guardan fondo, ajuste, oscurecimiento, logo, posición y tamaño.']],
      ['Grabación', ['Use Alt+R cuando OBS y la escena estén listos. La grabación usa una ventana limpia de salida para no capturar controles.', 'Vuelva a la ventana de Sala de transmisión para cambiar diseño, invitados, efectos, compartir o detener.']],
      ['Respaldo local de invitados y grabación con bot', ['Durante una grabación local, navegadores compatibles pueden crear partes locales de respaldo. Si la grabación principal se congela, esas partes pueden sustituir las zonas dañadas.', 'La grabación con bot es opcional y se alterna con Alt+Ctrl+B.']],
      ['Directo en YouTube', ['Prepare escena y OBS, elija o cree el directo y use Alt+Ctrl+L para iniciar o detener. Se recomienda una prueba privada o no listada.', 'Existe parada de emergencia si la interfaz se vuelve difícil de controlar.']],
      ['Subtítulos, traducción y doblaje en vivo', ['Active traducción/subtítulos, elija servicio, idioma origen, destino y modo. OpenAI se recomienda para texto, Gemini Live Translate para traducción hablada y ElevenLabs especialmente para doblaje posterior.', 'Cada invitado elige su idioma. Si ya se habla en el idioma destino, no se reproduce una voz traducida igual.']],
      ['Doblaje posterior con ElevenLabs', ['Tras grabar, puede enviar el archivo a ElevenLabs Dubbing y crear un MP4 doblado con voz traducida delante y original debajo.', 'Los segmentos guardados pueden remezclarse sin reenviar el trabajo.']],
      ['Claves API y servicios de IA', ['Las claves se gestionan desde el menú IA. Gemini se usa para feedback visual y Live Translate; OpenAI para texto y respaldo; ElevenLabs para Scribe, voces y doblaje.']],
      ['Capa de efectos', ['Permite disparar jingles, sonidos, videos y efectos visuales durante grabación o directo. Los efectos llegan a la salida final.']],
      ['Pantalla compartida', ['El anfitrión usa Alt+S. Elija pantalla, ventana o fuente y opcionalmente audio del sistema. Invitados usan el selector del navegador.', 'Con documento accesible se puede subir PowerPoint, Word u otro archivo para que invitados ciegos sigan el texto.']],
      ['Participantes y chat', ['Alt+U abre la lista. Flechas mueven, Flecha derecha abre menú, Flecha izquierda o Escape lo cierra.', 'El menú incluye expulsar, mensaje, silenciar, cámara, permisos, panelista, intérpretes y solicitudes de palabra.']],
      ['Webinar', ['Modo para audiencias grandes donde solo panelistas seleccionados hablan o aparecen. Administradores pueden aprobar solicitudes y entregar una clave al anfitrión.']],
      ['Opinión de IA sobre la escena', ['Analiza el fotograma real y avisa sobre rostros visibles, pantalla, zonas negras o controles no deseados. Gemini es principal y OpenAI puede ser respaldo.']],
      ['Atajos principales', ['Anfitrión: Alt+A micrófono, Alt+V cámara, Alt+S compartir, Alt+Y diseño, Alt+U participantes, Alt+C chat, Alt+O gestión, Alt+Q salir/finalizar, Alt+R grabar, Alt+L regiones, Alt+Ctrl+L YouTube, Alt+Ctrl+B bot, Alt+Ctrl+T subtítulos/traducción.', 'Invitado: Ctrl+D micrófono, Ctrl+E cámara, Ctrl+Shift+E compartir, Ctrl+Shift+H salir.']],
      ['Solución de problemas', ['Sin audio de invitado: permisos y dispositivos. Sin audio compartido: compruebe si el navegador ofrece audio para esa fuente. Si no inicia subtítulos/traducción, revise activación y claves API.', 'Use Diagnóstico e historial para audio, video, participantes y YouTube/grabación.']]
    ]
  },
  fr: {
    file: 'guide-salle-diffusion-evd.html',
    title: 'Guide de la Salle de diffusion EVD',
    lead: 'Ce guide explique la Salle de diffusion EVD pour les directs, réunions, interviews, enregistrements, partages d’écran, sous-titres, traductions, doublage, gestion des participants et mise en scène accessible.',
    product: 'Éditeur vidéo accessible',
    section: 'Salle de diffusion',
    docType: 'Guide HTML/PDF partageable',
    updated: '13 juin 2026',
    toc: 'Sommaire',
    footer: 'Ce document est le guide partageable de l’aide de la Salle de diffusion EVD.',
    sections: [
      ['Qu’est-ce que la Salle de diffusion ?', ['C’est un espace de production où vous invitez des personnes par lien, recevez caméra, micro et partage d’écran, puis envoyez la scène vers l’enregistrement ou YouTube.', 'Le flux se fait en deux temps : ouvrir la salle, puis décider comment les personnes et contenus apparaissent.'], ['Salles temporaires et persistantes', 'Caméra, micro, chat, partage et commandes participants', 'Mises en scène manuelles, arrière-plans, logos, sous-titres, traduction, langue des signes, enregistrement, YouTube et effets']],
      ['Interface', ['Alt+L ouvre la liste des régions. Utilisez les flèches et Entrée. Ctrl+Droite et Ctrl+Gauche changent rapidement de région.'], ['Salle et appareils', 'Participants et chat', 'Partage et sources', 'Mise en scène', 'Arrière-plans', 'OBS, enregistrement, YouTube, effets', 'Sous-titres et traduction', 'Diagnostic et historique']],
      ['Ouvrir une salle temporaire ou persistante', ['Créez une salle rapide ou ouvrez Gestion de salle avec Alt+O pour une salle persistante avec clé de lien, mot de passe et règles sans hôte.', 'La liste se contrôle avec flèches, Entrée et Flèche droite pour le menu.']],
      ['Page invité', ['La page invité est simple. Les appareils sont dans Options des appareils ; le flux principal est nom, mot de passe éventuel et rejoindre.'], ['Micro : Ctrl+D', 'Caméra : Ctrl+E', 'Partager : Ctrl+Shift+E', 'Quitter : Ctrl+Shift+H', 'Chat, participants, informations, sous-titres et texte accessible sont dans des panneaux repliables.']],
      ['Mises en scène', ['Elles déterminent l’apparence de l’hôte, des invités et des partages. Le menu d’affectation permet de placer les sources manuellement.', 'Pendant un partage, EVD peut garder les intervenants en petites fenêtres et revenir à la mise en scène précédente.']],
      ['Arrière-plans, logo et profils', ['JPG, PNG, WebP, BMP, MP4, WebM, MOV et MKV sont possibles. EVD avertit ou convertit si le format n’est pas adapté à 1920x1080.', 'Les profils gardent arrière-plan, ajustement, assombrissement, logo, position et taille.']],
      ['Enregistrement', ['Alt+R lance l’enregistrement quand OBS et la scène sont prêts. La sortie propre évite de capturer les contrôles.', 'Revenez à la Salle de diffusion pour changer la scène, gérer les invités, effets, partages ou arrêter.']],
      ['Sauvegarde locale invité et bot', ['Pendant un enregistrement local, les navigateurs compatibles peuvent créer des morceaux de secours. Ils peuvent remplacer des zones figées de l’enregistrement principal.', 'L’enregistrement bot est optionnel et se bascule avec Alt+Ctrl+B.']],
      ['Direct YouTube', ['Préparez scène et OBS, choisissez ou créez le direct, puis utilisez Alt+Ctrl+L pour démarrer ou arrêter. Un test privé est conseillé.', 'Un arrêt d’urgence est disponible si l’interface devient difficile à contrôler.']],
      ['Sous-titres, traduction et doublage', ['Activez traduction/sous-titres, choisissez service, langue source, cible et mode. OpenAI est conseillé pour le texte, Gemini Live Translate pour la voix, ElevenLabs surtout pour le doublage après enregistrement.', 'Chaque invité choisit sa langue. Si la parole est déjà dans la langue cible, la voix traduite identique n’est pas jouée.']],
      ['Doublage ElevenLabs après enregistrement', ['Après l’enregistrement, envoyez le fichier à ElevenLabs Dubbing pour créer un MP4 doublé avec voix traduite devant et original dessous.', 'Les segments gardés peuvent être remixés sans relancer le service.']],
      ['Clés API et services IA', ['Les clés sont dans le menu IA. Gemini sert au retour visuel et Live Translate ; OpenAI au texte et secours ; ElevenLabs à Scribe, voix et doublage.']],
      ['Couche d’effets', ['Déclenchez jingles, sons, vidéos et effets visuels pendant enregistrement ou direct. Ils vont dans la sortie finale.']],
      ['Partage d’écran', ['L’hôte utilise Alt+S. Choisissez écran, fenêtre ou source et éventuellement audio système. Les invités utilisent le sélecteur du navigateur.', 'Le partage de document accessible permet d’ajouter PowerPoint, Word ou autre fichier pour que les invités aveugles suivent le texte.']],
      ['Participants et chat', ['Alt+U ouvre la liste. Flèches pour naviguer, Flèche droite pour le menu, Flèche gauche ou Escape pour fermer.', 'Le menu contient expulser, message, muet, caméra, autorisations, paneliste, rôles interprètes et demandes de parole.']],
      ['Webinar', ['Mode pour grands publics : seuls certains panelistes parlent ou apparaissent. Les admins valident les demandes et fournissent une clé à l’hôte.']],
      ['Avis IA sur la scène', ['Analyse l’image réelle : visages visibles, placement du partage, zones noires ou contrôles indésirables. Gemini est prioritaire, OpenAI peut servir de secours.']],
      ['Raccourcis principaux', ['Hôte : Alt+A micro, Alt+V caméra, Alt+S partage, Alt+Y mise en scène, Alt+U participants, Alt+C chat, Alt+O gestion, Alt+Q quitter/terminer, Alt+R enregistrer, Alt+L régions, Alt+Ctrl+L YouTube, Alt+Ctrl+B bot, Alt+Ctrl+T sous-titres/traduction.', 'Invité : Ctrl+D micro, Ctrl+E caméra, Ctrl+Shift+E partage, Ctrl+Shift+H quitter.']],
      ['Dépannage', ['Pas d’audio invité : permissions et appareils. Pas d’audio de partage : vérifier le navigateur. Sous-titres/traduction : vérifier activation et clés API.', 'Consultez Diagnostic et historique pour audio, vidéo, participants, YouTube et enregistrement.']]
    ]
  }
};

function slug(index) {
  return `section-${String(index + 1).padStart(2, '0')}`;
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderGuide(lang, guide) {
  const toc = guide.sections.map((section, index) => (
    `        <li><a href="#${slug(index)}">${escapeHtml(section[0])}</a></li>`
  )).join('\n');
  const sections = guide.sections.map((section, index) => {
    const paragraphs = section[1].map((text) => `      <p>${escapeHtml(text)}</p>`).join('\n');
    const bullets = Array.isArray(section[2]) && section[2].length
      ? `\n      <ul>\n${section[2].map((text) => `        <li>${escapeHtml(text)}</li>`).join('\n')}\n      </ul>`
      : '';
    return `    <section id="${slug(index)}">\n      <h2>${index + 1}. ${escapeHtml(section[0])}</h2>\n${paragraphs}${bullets}\n    </section>`;
  }).join('\n\n');
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(guide.title)}</title>
  <style>${css}</style>
</head>
<body>
  <main class="page">
    <h1>${escapeHtml(guide.title)}</h1>
    <p class="lead">${escapeHtml(guide.lead)}</p>
    <div class="meta">
      <span><strong>Product:</strong> ${escapeHtml(guide.product)}</span>
      <span><strong>Section:</strong> ${escapeHtml(guide.section)}</span>
      <span><strong>Document:</strong> ${escapeHtml(guide.docType)}</span>
      <span><strong>Updated:</strong> ${escapeHtml(guide.updated)}</span>
    </div>
    <section class="toc">
      <h2>${escapeHtml(guide.toc)}</h2>
      <ol>
${toc}
      </ol>
    </section>

${sections}

    <p class="footer">${escapeHtml(guide.footer)}</p>
  </main>
</body>
</html>
`;
}

for (const [lang, guide] of Object.entries(guides)) {
  fs.writeFileSync(path.join(outputDir, guide.file), renderGuide(lang, guide), 'utf8');
}

console.log(`Broadcast room guides written to ${outputDir}`);
