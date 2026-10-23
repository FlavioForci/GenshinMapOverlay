; Zusatzseite "Overlay language" im NSIS-Setup.
; Wahl landet in $INSTDIR\language.txt → resolveLanguage() in src/main.js

; Uninstaller nutzt dasselbe Skript, dort wären die Variablen unbenutzt → Fehler
!ifndef BUILD_UNINSTALLER
  Var OverlayLanguage
  Var LanguageRadioEnglish
  Var LanguageRadioGerman
!endif

!macro customPageAfterChangeDir
  Page custom OverlayLanguagePageShow OverlayLanguagePageLeave

  Function OverlayLanguagePageShow
    !insertmacro MUI_HEADER_TEXT "Overlay language" "Choose the language of the overlay and the marker names."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 24u "Which language should Genshin Map Overlay use? You can change it later in the tray menu (Language / Sprache)."
    Pop $0
    ${NSD_CreateRadioButton} 10u 34u 100% 12u "English"
    Pop $LanguageRadioEnglish
    ${NSD_CreateRadioButton} 10u 50u 100% 12u "Deutsch (German)"
    Pop $LanguageRadioGerman

    ; Vorauswahl: frühere Wahl > deutsches Windows (Sprach-ID 7) > Englisch
    System::Call 'kernel32::GetUserDefaultUILanguage() i .r1'
    IntOp $1 $1 & 0x3FF
    StrCpy $2 "en"
    ${If} $OverlayLanguage == "de"
      StrCpy $2 "de"
    ${ElseIf} $OverlayLanguage == ""
    ${AndIf} $1 == 7
      StrCpy $2 "de"
    ${EndIf}
    ${If} $2 == "de"
      ${NSD_Check} $LanguageRadioGerman
    ${Else}
      ${NSD_Check} $LanguageRadioEnglish
    ${EndIf}

    nsDialogs::Show
  FunctionEnd

  Function OverlayLanguagePageLeave
    ${NSD_GetState} $LanguageRadioGerman $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $OverlayLanguage "de"
    ${Else}
      StrCpy $OverlayLanguage "en"
    ${EndIf}
  FunctionEnd
!macroend

!macro customInstall
  ; Stille Installation/Update überspringt die Seite → Windows-Sprache
  ${If} $OverlayLanguage != ""
    FileOpen $0 "$INSTDIR\language.txt" w
    FileWrite $0 $OverlayLanguage
    FileClose $0
  ${EndIf}
!macroend
