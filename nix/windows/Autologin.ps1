Set-StrictMode -Version Latest

function Set-DevboxAutologin([string]$ComputerName) {
    if ($ComputerName -notmatch '^[A-Za-z0-9-]{1,15}$') { throw 'Invalid autologin computer name' }
    # The generated account credential is also the private SMB credential.
    # Password expiry would break unattended desktop login after 42 days.
    Set-LocalUser -Name 'wbdev' -PasswordNeverExpires $true
    if (-not ('WinBoatDev.AutologinSecret' -as [type])) {
        # Winlogon uses the DefaultPassword LSA secret, as documented for
        # Sysinternals Autologon. Keep the password out of the Winlogon registry.
        # https://learn.microsoft.com/en-us/sysinternals/downloads/autologon
        # https://learn.microsoft.com/en-us/windows/win32/api/ntsecapi/nf-ntsecapi-lsastoreprivatedata
        Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace WinBoatDev {
    public static class AutologinSecret {
        [StructLayout(LayoutKind.Sequential)]
        private struct Attributes {
            public uint Length;
            public IntPtr RootDirectory, ObjectName;
            public uint Flags;
            public IntPtr SecurityDescriptor, SecurityQualityOfService;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct UnicodeString {
            public ushort Length, MaximumLength;
            public IntPtr Buffer;
        }
        [DllImport("advapi32.dll")]
        private static extern uint LsaOpenPolicy(IntPtr system, ref Attributes attributes, uint access, out IntPtr policy);
        [DllImport("advapi32.dll")]
        private static extern uint LsaStorePrivateData(IntPtr policy, ref UnicodeString key, ref UnicodeString value);
        [DllImport("advapi32.dll")]
        private static extern uint LsaNtStatusToWinError(uint status);
        [DllImport("advapi32.dll")]
        private static extern uint LsaClose(IntPtr policy);
        private static UnicodeString Allocate(string value) {
            if (value == null || value.Length > 32766) throw new ArgumentException("Invalid LSA string length");
            return new UnicodeString { Length = (ushort)(value.Length * 2),
                MaximumLength = (ushort)((value.Length + 1) * 2), Buffer = Marshal.StringToHGlobalUni(value) };
        }
        private static void Check(uint status) {
            if (status != 0) throw new Win32Exception((int)LsaNtStatusToWinError(status));
        }
        public static void Store(string password) {
            IntPtr policy = IntPtr.Zero;
            UnicodeString key = new UnicodeString(), value = new UnicodeString();
            try {
                var attributes = new Attributes { Length = (uint)Marshal.SizeOf(typeof(Attributes)) };
                Check(LsaOpenPolicy(IntPtr.Zero, ref attributes, 0x20, out policy)); // POLICY_CREATE_SECRET
                key = Allocate("DefaultPassword");
                value = Allocate(password);
                Check(LsaStorePrivateData(policy, ref key, ref value));
            } finally {
                if (value.Buffer != IntPtr.Zero) Marshal.ZeroFreeGlobalAllocUnicode(value.Buffer);
                if (key.Buffer != IntPtr.Zero) Marshal.FreeHGlobal(key.Buffer);
                if (policy != IntPtr.Zero) LsaClose(policy);
            }
        }
    }
}
'@
    }
    $password = (Get-Content -Raw -LiteralPath 'C:\ProgramData\WinBoatDev\share-password').Trim()
    if (-not $password) { throw 'Missing generated devbox account password' }
    [WinBoatDev.AutologinSecret]::Store($password)
    $winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
    foreach ($name in @('DefaultPassword', 'AutoLogonCount')) {
        Remove-ItemProperty -LiteralPath $winlogon -Name $name -ErrorAction SilentlyContinue
    }
    foreach ($item in @{ DefaultUserName = 'wbdev'; DefaultDomainName = $ComputerName; AutoAdminLogon = '1' }.GetEnumerator()) {
        New-ItemProperty -LiteralPath $winlogon -Name $item.Key -Value $item.Value -PropertyType String -Force | Out-Null
    }
    return @{ enabled = $true; username = 'wbdev'; domain = $ComputerName; passwordStorage = 'lsa-secret'; passwordNeverExpires = $true }
}
