# Genshin Map Overlay (Deutsch)

Alle Marker, direkt auf deiner **Ingame-Karte**. Drück in Genshin Impact auf **M**, und das Overlay legt
Truhen, Oculi, Rätsel und 690 weitere Markerarten auf die Karte, mit einem Foto zu jedem Fundort. Es
folgt, wenn du ziehst und zoomst, und fasst das Spiel nie an.

**[Neueste Version herunterladen](https://github.com/FlavioForci/GenshinMapOverlay/releases/latest)** ·
[Webseite](https://genshin-map-overlay.pages.dev) · [Discord](https://discord.gg/TaKd4BU8f) ·
[Auf Ko-fi unterstützen](https://ko-fi.com/s/819525a108)

English: [README.md](README.md)

## Installieren

1. `GenshinMapOverlay-Setup-<Version>.exe` unter
   [Releases](https://github.com/FlavioForci/GenshinMapOverlay/releases/latest) herunterladen.
2. Starten. Windows zeigt eventuell **„Der Computer wurde durch Windows geschützt“**, weil die App noch
   nicht digital signiert ist: **Weitere Informationen**, dann **Trotzdem ausführen**.
3. Sprache des Overlays wählen (Deutsch oder Englisch) und installieren. Keine Admin-Rechte nötig.
4. Das Overlay startet und sitzt im Infobereich (Kompass-Symbol neben der Uhr). Beim ersten Start lädt
   es Markerdaten und Kartenerkennung, das dauert ein paar Sekunden.
5. Das Spiel über das Tray-Menü mit **Genshin randlos starten** öffnen.
6. Im Spiel mit **M** die Karte öffnen. Die Marker erscheinen von selbst.

Tipp: Tray-Menü → **Mit Windows starten**, dann ist das Overlay immer bereit.

### Voraussetzungen

- Windows 10 (ab Version 2004) oder Windows 11
- Genshin Impact für PC, randlos oder im Fenster (nicht exklusives Vollbild, siehe unten)
- Getestet mit 1920×1080 und 4K

### macOS (Apple Silicon, Beta)

Es gibt eine Mac-Version für Apple Silicon (M1 und neuer). Sie ist noch nicht so ausgiebig getestet
wie die Windows-Version, bitte melde Auffälligkeiten im [Discord](https://discord.gg/TaKd4BU8f).

1. `GenshinMapOverlay-<Version>-mac-arm64.zip` unter
   [Releases](https://github.com/FlavioForci/GenshinMapOverlay/releases/latest) laden, entpacken und
   **Genshin Map Overlay.app** in den Programme-Ordner ziehen.
2. Die App ist nicht mit einem Apple-Entwicklerzertifikat signiert, deshalb blockiert macOS den ersten
   Start. **Systemeinstellungen → Datenschutz & Sicherheit** öffnen, nach unten scrollen und
   **Trotzdem öffnen** klicken. Alternativ im Terminal:
   `xattr -dr com.apple.quarantine "/Applications/Genshin Map Overlay.app"`
3. Bildschirmaufnahme erlauben: **Systemeinstellungen → Datenschutz & Sicherheit → Bildschirmaufnahme**,
   **Genshin Map Overlay** einschalten, dann das Overlay beenden und neu starten.
4. Das Overlay sitzt in der Menüleiste (Kompass-Symbol), es gibt kein Dock-Symbol. Auf Mac-Tastaturen
   brauchen die F-Tasten eventuell **fn**.

„Genshin randlos starten“ und der Tasten-Helfer gibt es nur unter Windows, auf dem Mac braucht man sie nicht.

### Linux (x64, Beta)

Es gibt eine Linux-Version als AppImage und `.deb`. Sie ist neu und mit dem Spiel kaum getestet, bitte
melde Auffälligkeiten im [Discord](https://discord.gg/TaKd4BU8f). Genshin läuft unter Linux nur über
Wine oder Proton. Das unterstützt HoYoverse nicht offiziell, unabhängig vom Overlay.

1. `GenshinMapOverlay-<Version>-linux-x86_64.AppImage` unter
   [Releases](https://github.com/FlavioForci/GenshinMapOverlay/releases/latest) laden, ausführbar
   machen (`chmod +x GenshinMapOverlay-*.AppImage`) und starten. AppImages brauchen FUSE 2: unter
   Ubuntu 22.04 `sudo apt install libfuse2`, unter Ubuntu 24.04 `sudo apt install libfuse2t64`.
   Unter Debian/Ubuntu geht stattdessen auch `GenshinMapOverlay-<Version>-linux-amd64.deb`
   (`sudo apt install ./GenshinMapOverlay-*-linux-amd64.deb`), gestartet wird dann übers App-Menü.
2. Das Overlay sitzt im Infobereich. Unter GNOME braucht das die Erweiterung **AppIndicator and
   KStatusNotifierItem Support** (bei Ubuntu schon dabei). Ohne Infobereich gehen die Tasten und der
   Reiter **Marker** an der Karte trotzdem. Beenden mit `pkill -f genshin-map-overlay`.
3. Genshin in den Grafikeinstellungen auf Fenster oder randlos stellen und die Karte mit **M** öffnen.

Voraussetzungen: Linux x64 mit X11 oder ein Wayland-Desktop mit XWayland (GNOME, KDE Plasma und die
meisten anderen), dazu ein Compositor für das durchsichtige Fenster.

Einschränkungen unter Linux:

- **Wayland:** Das Overlay startet sich selbst unter XWayland (X11) neu, weil natives Wayland Apps
  kein durchklickbares Fenster immer oben und keine globalen Tasten erlaubt. Die Bildschirmaufnahme
  läuft über den Systemdialog (PipeWire): den Bildschirm mit dem Spiel wählen. Der Dialog kommt bei
  jedem Start des Overlays wieder. Natives Wayland erzwingt `--ozone-platform=wayland`, dann gehen
  Position, Klicks und Tasten aber meist nicht.
- **Tasten** gehen, solange das Spielfenster den Fokus hat. Hält das Spiel im Vollbild die Tastatur
  fest, das Tray-Menü oder den Reiter an der Karte nehmen.
- **Screenshots:** Linux kann Fenster nicht aus Bildschirmaufnahmen ausblenden. Das Overlay ist in
  Screenshots und Streams zu sehen, der Schalter **In Screenshots sichtbar** fehlt im Panel. Die
  Kartenerkennung sieht die Marker mit, das kann sie etwas unruhiger machen.
- **Genshin randlos starten** und der Tasten-Helfer gibt es nur unter Windows.
- Noch nicht getestet: mehrere Monitore, Gamescope, Wines virtueller Desktop, Tippen in der Panel-Suche.

Einstellungen, Cache, Log und gefundene Marker liegen in `~/.config/Genshin Map Overlay`. Tray-Menü →
**Beim Anmelden starten** trägt das Overlay in `~/.config/autostart` ein.

## Bedienung

| Taste | Funktion |
|---|---|
| **M** (im Spiel) | Karte öffnen, Marker erscheinen automatisch |
| **F7** | Overlay ein/aus (aus = keine Bildschirmaufnahme, keine Rechenlast) |
| **F8** | Marker-Panel auf/zu |
| **F9** | Gefundene Marker ein-/ausblenden |
| **F10** | Deckkraft der Marker wechseln |

- **Linksklick auf einen Marker:** die Fundort-Karte zeigt Foto oder Video. Klick aufs Foto vergrößert es.
- **Rechtsklick auf einen Marker:** als gefunden markieren (oder wieder offen).
- **Panel:** Markerarten anhaken, nach Namen suchen, Größe und Deckkraft einstellen. Es geht auch über
  den Reiter **Marker** am rechten Kartenrand auf.
- Klicks neben die Marker gehen ganz normal ans Spiel (ziehen, zoomen, Wegpunkte setzen).
- Außerhalb der Karte hält das Spiel die Maus fest. Dort **Alt** gedrückt halten, um im Panel zu klicken.

Der Fortschritt wird lokal in benannten Profilen gespeichert. Öffne **Profile & Übertragung** im
Tray-Menü oder Marker-Panel, um ein Profil anzulegen, Name und Region / Notiz zu ändern oder das Profil
zu wechseln. Jedes Profil hat eigene gefundene Marker, Markerfilter und die F9-Sichtbarkeit.

Unter Windows liegen die lokalen Dateien in `%APPDATA%\Genshin Map Overlay\progress`, unter macOS in
`~/Library/Application Support/Genshin Map Overlay/progress`. Beim ersten Upgrade werden `found.json`
und die alten Marker-Einstellungen aus `settings.json` einmalig importiert. Ihre ursprünglichen Bytes
bleiben in internen Wiederherstellungssicherungen erhalten. Spätere Änderungen an diesen alten Feldern
ändern den Profilfortschritt nicht.

Mit **Alle Profile exportieren…** erstellst du eine portable JSON-Sicherung. **Sicherung importieren…**
legt neue Profile an, erhält vorhandene Profile und aktiviert das erste importierte Profil. Beim Abbrechen
eines Dialogs ändert sich nichts. Die Sicherungen enthalten wirksamen Fortschritt und Profileinstellungen,
aber keine Konto- oder Installationsidentität. Bewahre eine Kopie außerhalb des App-Ordners auf; ein
Google-Konto oder eine Cloud-Einrichtung ist nicht nötig.

Wenn lokale Dateien nicht lesbar sind oder eine Speicherung nicht bestätigt werden kann, ist der
Fortschritt schreibgeschützt. Behebe den Speicherzugriff und wähle in **Profile & Übertragung** zunächst
**Lokale Dateien erneut versuchen**; dabei werden aktuelle Daten gelesen und keine älteren Daten
wiederhergestellt. **Letzte gültige Sicherung wiederherstellen** ersetzt den lokalen Fortschritt ausdrücklich
durch den geprüften vorherigen Stand und erhält Originaldateien zur Wiederherstellung. Kann das Beenden
eine Speicherung nicht abschließen, bleibt die App mit einer Fehlermeldung offen. Behebe das Speicherproblem
und versuche erneut zu beenden.

## Ist das sicher für meinen Account?

Das Overlay ist ein eigenes, durchsichtiges Fenster. Es

- liest oder ändert **nicht** den Speicher oder die Dateien des Spiels,
- schleust **nichts** ein (keine DLL, kein Grafik-Hook),
- schickt **keine** Tasten oder Klicks ans Spiel.

Um zu wissen, wo die Karte ist, macht es eine normale Bildschirmaufnahme, wie OBS oder Discord beim
Bildschirm-Teilen. HoYoverse gibt für Overlays grundsätzlich keine offizielle Freigabe, deshalb kann
niemand null Risiko versprechen. Ein Fenster, das das Spiel nie anfasst, ist aber der sicherste Weg.

## Wenn etwas nicht klappt

- **Keine Marker:** Genshins exklusives Vollbild verdeckt alle anderen Fenster. Das Spiel über
  **Genshin randlos starten** im Tray-Menü öffnen oder in den Grafikeinstellungen den Fenstermodus
  wählen. Bei mehreren Monitoren im Tray-Menü unter **Bildschirm mit dem Spiel** den richtigen wählen.
- **Tasten gehen im Spiel nicht:** Genshin läuft mit Admin-Rechten, und Windows gibt Tastenkürzel nur an
  Programme mit gleichen Rechten weiter. Das Overlay startet dafür einen kleinen Helfer für F7–F10,
  Windows fragt einmal nach. Falls abgelehnt: Tray-Menü → **Tasten im Spiel aktivieren**. Das Panel geht
  auch über den Reiter an der Karte auf.
- **„Bildschirmaufnahme fehlgeschlagen“:** Das Overlay wurde als Administrator gestartet. Normal starten.
- **Eine Taste ist belegt:** Das Overlay meldet das beim Start. In der Einstellungsdatei ändern.
- **Marker sitzen daneben:** einen Screenshot der offenen Karte (`Win` + `Druck`) im
  [Discord](https://discord.gg/TaKd4BU8f) posten.

## Einstellungen

Tray-Menü → **Erweitert** → **Einstellungsdatei öffnen**, danach **Einstellungen neu laden**.

| Schlüssel | Bedeutung |
|---|---|
| `hotkeys` | Tasten, z. B. `"F7"`, `"Alt+M"`, `"Ctrl+Shift+F1"` |
| `markerSize` | Markergröße in Pixeln bei 1080p (auch im Panel) |
| `language` | `"de"` oder `"en"`; leer = aus dem Setup bzw. von Windows |
| `showInCaptures` | `true` = Overlay ist in Screenshots, Aufnahmen und Streams zu sehen (auch im Panel) |
| `genshinPath` | Pfad zur `GenshinImpact.exe`, falls sie nicht automatisch gefunden wird |

## Datenschutz

Das Overlay lädt Markerdaten, Fotos und Kartenerkennung von `genshin-map-overlay.pages.dev`, dazu
YouTube-Vorschaubilder bei Fundorten mit Video. Es lädt nichts hoch. Bildschirmaufnahmen bleiben auf
deinem PC und werden nie gespeichert.

## Deinstallieren

Windows-Einstellungen → Apps → **Genshin Map Overlay**. Einstellungen, Cache und gefundene Marker liegen
in `%APPDATA%\Genshin Map Overlay` und können danach gelöscht werden.

## Hinweis

Fanprojekt, nicht mit HoYoverse verbunden und nicht von HoYoverse unterstützt. Genshin Impact und alle
zugehörigen Namen und Bilder sind Marken von HoYoverse. Markerdaten und Fotos stammen von der Community
von [genshin-impact-map.appsample.com](https://genshin-impact-map.appsample.com), .
