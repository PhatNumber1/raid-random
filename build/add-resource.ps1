# Puts the app's code into the .exe, using Windows' own function for it.
param([Parameter(Mandatory)][string]$Exe, [Parameter(Mandatory)][string]$Blob)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class Res {
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr BeginUpdateResource(string file, bool deleteExisting);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool UpdateResource(IntPtr h, IntPtr type, string name, ushort lang, byte[] data, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool EndUpdateResource(IntPtr h, bool discard);
  public static void Add(string file, string name, byte[] data) {
    IntPtr h = BeginUpdateResource(file, false);
    if (h == IntPtr.Zero) throw new Win32Exception();
    if (!UpdateResource(h, (IntPtr)10, name, 0, data, (uint)data.Length)) throw new Win32Exception();
    if (!EndUpdateResource(h, false)) throw new Win32Exception();
  }
}
'@
$data = [IO.File]::ReadAllBytes($Blob)
# Antivirus may still hold a file that was just written, so try a few times.
for ($i = 1; ; $i++) {
  try { [Res]::Add($Exe, 'NODE_SEA_BLOB', $data); break } catch { if ($i -ge 10) { throw }; Start-Sleep -Milliseconds 1500 }
}
