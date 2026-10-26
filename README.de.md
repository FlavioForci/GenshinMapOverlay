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

## Bedienung

| Taste | Funktion |
|---|---|
| **M** (im Spiel) | Karte öffnen, Marker erscheinen automatisch |
| **F7** | Overlay ein/aus (aus = keine Bildschirmaufnahme, keine Rechenlast) |
| **F8** | Marker-Panel auf/zu |
| **F9** | Gefundene Marker ein-/ausblenden |
| **F10** | Deckkraft der Marker wechseln |
| **Alt+E** | Marker in der Nähe als gefunden markieren (nur solange der Hinweis neben der Minimap steht) |

- **Linksklick auf einen Marker:** die Fundort-Karte zeigt Foto oder Video. Klick aufs Foto vergrößert es.
- **Rechtsklick auf einen Marker:** als gefunden markieren (oder wieder offen).
- **Panel:** Markerarten anhaken, nach Namen suchen, Größe und Deckkraft einstellen. Es geht auch über
  den Reiter **Marker** am rechten Kartenrand auf.
- Klicks neben die Marker gehen ganz normal ans Spiel (ziehen, zoomen, Wegpunkte setzen).
- Außerhalb der Karte hält das Spiel die Maus fest. Dort **Alt** gedrückt halten, um im Panel zu klicken.

Gefundene Marker werden nur auf deinem PC gespeichert (`%APPDATA%\Genshin Map Overlay\found.json`).

### Minimap

- Nach dem Start des Overlays oder nach einem Teleport einmal mit **M** die Karte öffnen und wieder
  schließen. Die Karte öffnet sich auf deine Figur zentriert, so weiß das Overlay, wo du bist, und zeigt
  die angehakten Markerarten auch auf der Minimap.
- Geh nah an einen Marker heran: Er bekommt einen Ring, und neben der Minimap erscheint ein Hinweis.
  **Alt+E** markiert ihn als gefunden. Die Taste ist nur belegt, solange der Hinweis zu sehen ist.
- Ausschalten im Panel oder im Tray-Menü (**Marker auf der Minimap**).
- Geprüft mit 16:9-Auflösungen im Vollbild oder randlos. Im Fenstermodus oder bei anderen
  Seitenverhältnissen (16:10, 21:9) erscheinen die Minimap-Marker eventuell noch nicht; die Marker auf
  der Karte funktionieren überall.

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
| `minimap` | `false` = keine Marker auf der Minimap (auch im Panel und im Tray-Menü) |
| `nearbyRadius` | Wie nah ein Marker für den Alt+E-Hinweis sein muss, in Kartenpixeln (Standard 7) |
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
