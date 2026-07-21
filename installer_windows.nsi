; Meeting Generator - NSIS Installer Script (per-user, no UAC)
; Usage: makensis installer_windows.nsi
; Output: dist/MeetingGenerator-Setup.exe

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"

!define APPNAME "Meeting Generator"
!define COMPANY "MeetingGenerator"
!define VERSION "0.3.0"
!define DIST_DIR "dist\MeetingGenerator"

Name "${APPNAME} ${VERSION}"
OutFile "dist\MeetingGenerator-Setup.exe"
InstallDir "$LOCALAPPDATA\${COMPANY}\${APPNAME}"
InstallDirRegKey HKCU "Software\${COMPANY}\${APPNAME}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma

; --- Branding ----------------------------------------------------
!define MUI_ABORTWARNING
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "LICENSE.txt"
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; --- WebView2 bootstrap ------------------------------------------
Var WebView2Installed
Var WebView2Bootstrapper

Function .onInit
    ReadRegStr $WebView2Installed HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
    ${If} $WebView2Installed == ""
        ReadRegStr $WebView2Installed HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
    ${EndIf}
FunctionEnd

Section "Meeting Generator (required)" SecMain
    SectionIn RO
    SetOutPath "$INSTDIR"

    File /r "${DIST_DIR}\*"

    WriteRegStr HKCU "Software\${COMPANY}\${APPNAME}" "InstallDir" "$INSTDIR"

    CreateDirectory "$SMPROGRAMS\${APPNAME}"
    CreateShortCut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\MeetingGenerator.exe"
    CreateShortCut "$SMPROGRAMS\${APPNAME}\Uninstall.lnk" "$INSTDIR\Uninstall.exe"

    CreateShortCut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\MeetingGenerator.exe"

    WriteUninstaller "$INSTDIR\Uninstall.exe"

    ; Per-user uninstall entry (Settings → Apps)
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${COMPANY}-${APPNAME}" "DisplayName" "${APPNAME}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${COMPANY}-${APPNAME}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${COMPANY}-${APPNAME}" "InstallLocation" '"$INSTDIR"'
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${COMPANY}-${APPNAME}" "DisplayIcon" '"$INSTDIR\MeetingGenerator.exe"'
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${COMPANY}-${APPNAME}" "DisplayVersion" "${VERSION}"
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${COMPANY}-${APPNAME}" "Publisher" "${COMPANY}"
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${COMPANY}-${APPNAME}" "NoModify" 1
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${COMPANY}-${APPNAME}" "NoRepair" 1

    ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
    WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${COMPANY}-${APPNAME}" "EstimatedSize" "$0"
SectionEnd

Section "Edge WebView2 Runtime (auto-detect)" SecWebView2
    ${If} $WebView2Installed == ""
        DetailPrint "Downloading Microsoft Edge WebView2 Runtime..."
        StrCpy $WebView2Bootstrapper "$TEMP\MicrosoftEdgeWebview2Setup.exe"
        NSISdl::download "https://go.microsoft.com/fwlink/p/?LinkId=2124703" "$WebView2Bootstrapper"
        Pop $0
        ${If} $0 == "success"
            DetailPrint "Installing WebView2 Runtime..."
            ExecWait '"$WebView2Bootstrapper" /silent /install' $1
            Delete "$WebView2Bootstrapper"
        ${Else}
            DetailPrint "WebView2 auto-install failed ($0). Meeting Generator may still work if Edge is installed."
        ${EndIf}
    ${Else}
        DetailPrint "WebView2 already installed ($WebView2Installed)."
    ${EndIf}
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
    !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "The Meeting Generator application and its shortcuts."
    !insertmacro MUI_DESCRIPTION_TEXT ${SecWebView2} "Installs the Microsoft Edge WebView2 Runtime if it isn't already present. Required for the app window to open."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
    ; App files
    RMDir /r "$INSTDIR"

    ; Shortcuts
    Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
    Delete "$SMPROGRAMS\${APPNAME}\Uninstall.lnk"
    RMDir "$SMPROGRAMS\${APPNAME}"
    Delete "$DESKTOP\${APPNAME}.lnk"

    ; Optional: remove user data (models are in the HF cache — those stay)
    MessageBox MB_YESNO "Also remove your Meeting Generator data (settings, transcripts, history)?$\r$\nWhisper models in the Hugging Face cache will be kept." IDNO SkipUserData
        RMDir /r "$APPDATA\MeetingGenerator"
    SkipUserData:

    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${COMPANY}-${APPNAME}"
    DeleteRegKey HKCU "Software\${COMPANY}\${APPNAME}"
SectionEnd

Function .onInstSuccess
    ExecShell "" "$INSTDIR\MeetingGenerator.exe"
FunctionEnd
