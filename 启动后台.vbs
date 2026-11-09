Option Explicit

Dim shell, fso, appDir, electronExe
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

appDir = fso.GetParentFolderName(WScript.ScriptFullName)
electronExe = fso.BuildPath(appDir, "node_modules\electron\dist\electron.exe")

If Not fso.FileExists(electronExe) Then
  MsgBox "Electron is not installed. Please run npm install first.", 16, "System Monitor"
  WScript.Quit 1
End If

shell.CurrentDirectory = appDir
shell.Run Chr(34) & electronExe & Chr(34) & " .", 0, False
