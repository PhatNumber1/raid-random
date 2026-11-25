# Puts the app's code and icon into the .exe, using Windows' own function for it.
param([Parameter(Mandatory)][string]$Exe, [Parameter(Mandatory)][string]$Blob, [Parameter(Mandatory)][string]$Icon)
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
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "UpdateResourceW")]
  static extern bool UpdateResourceId(IntPtr h, IntPtr type, IntPtr id, ushort lang, byte[] data, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool EndUpdateResource(IntPtr h, bool discard);
  // An .ico file holds several pictures. Windows wants each one separately, plus a list of them.
  static void AddIcon(IntPtr h, byte[] ico) {
    int count = BitConverter.ToUInt16(ico, 4);
    byte[] list = new byte[6 + 14 * count];
    Array.Copy(ico, list, 6);
    for (int i = 0; i < count; i++) {
      int entry = 6 + 16 * i, size = BitConverter.ToInt32(ico, entry + 8), at = BitConverter.ToInt32(ico, entry + 12), id = 501 + i;
      byte[] picture = new byte[size];
      Array.Copy(ico, at, picture, 0, size);
      if (!UpdateResourceId(h, (IntPtr)3, (IntPtr)id, 0, picture, (uint)size)) throw new Win32Exception();
      Array.Copy(ico, entry, list, 6 + 14 * i, 12);
      Array.Copy(BitConverter.GetBytes((ushort)id), 0, list, 6 + 14 * i + 12, 2);
    }
    // A name sorts before numbers, so Windows shows this icon instead of the one Node.js has.
    if (!UpdateResource(h, (IntPtr)14, "APPICON", 0, list, (uint)list.Length)) throw new Win32Exception();
  }
  public static void Add(string file, string name, byte[] data, byte[] ico) {
    IntPtr h = BeginUpdateResource(file, false);
    if (h == IntPtr.Zero) throw new Win32Exception();
    if (!UpdateResource(h, (IntPtr)10, name, 0, data, (uint)data.Length)) throw new Win32Exception();
    AddIcon(h, ico);
    if (!EndUpdateResource(h, false)) throw new Win32Exception();
  }
}
'@
$data = [IO.File]::ReadAllBytes($Blob)
$ico = [IO.File]::ReadAllBytes($Icon)
# Antivirus may still hold a file that was just written, so try a few times.
for ($i = 1; ; $i++) {
  try { [Res]::Add($Exe, 'NODE_SEA_BLOB', $data, $ico); break } catch { if ($i -ge 10) { throw }; Start-Sleep -Milliseconds 1500 }
}
