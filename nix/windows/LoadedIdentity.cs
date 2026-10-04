using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

// Compare executable mapped sections with the selected disk image, undoing PE
// base relocations. Reading the current disk filename alone cannot detect an
// older DLL retained by a running process.
public static class WinBoatLoadedIdentity {
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] data, IntPtr size, out IntPtr read);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static uint U32(byte[] data, int offset) { return BitConverter.ToUInt32(data,offset); }
    static ushort U16(byte[] data, int offset) { return BitConverter.ToUInt16(data,offset); }
    static byte[] Read(IntPtr process, long address, int length) {
        if (length<0 || length>128*1024*1024) throw new InvalidDataException("Mapped section outside size bound");
        byte[] data=new byte[length]; IntPtr read;
        if (!ReadProcessMemory(process,new IntPtr(address),data,new IntPtr(length),out read) || read.ToInt64()!=length)
            throw new IOException("Mapped image unreadable: "+Marshal.GetLastWin32Error());
        return data;
    }
    static int Offset(byte[] file, int sections, int count, uint rva) {
        for(int i=0;i<count;i++) {
            int s=sections+40*i; uint start=U32(file,s+12), size=Math.Max(U32(file,s+8),U32(file,s+16));
            if(rva>=start && rva-start<size) return checked((int)(U32(file,s+20)+rva-start));
        }
        throw new InvalidDataException("PE RVA has no file section");
    }
    public static string Verify(int pid, long address, string path) {
        byte[] file=File.ReadAllBytes(path); int pe=checked((int)U32(file,0x3c));
        if(U32(file,pe)!=0x4550) throw new InvalidDataException("Not a PE image");
        int count=U16(file,pe+6), optional=pe+24, sections=optional+U16(file,pe+20);
        bool x64=U16(file,optional)==0x20b;
        ulong imageBase=x64?BitConverter.ToUInt64(file,optional+24):U32(file,optional+28);
        long delta=unchecked(address-(long)imageBase);
        IntPtr process=OpenProcess(0x1010,false,pid);
        if(process==IntPtr.Zero) throw new IOException("Process unreadable: "+Marshal.GetLastWin32Error());
        try {
            byte[] header=Read(process,address,Math.Min(file.Length,4096));
            int mappedPe=checked((int)U32(header,0x3c));
            if(U32(header,mappedPe+8)!=U32(file,pe+8) || U32(header,mappedPe+24+56)!=U32(file,optional+56))
                return "stale-mapped-image";
            int dataDirectories=optional+(x64?112:96);
            uint relocRva=U32(file,dataDirectories+5*8), relocSize=U32(file,dataDirectories+5*8+4);
            int reloc=relocSize==0?0:Offset(file,sections,count,relocRva);
            int verified=0;
            for(int i=0;i<count;i++) {
                int s=sections+40*i;
                if((U32(file,s+36)&0x20000000)==0) continue;
                uint rva=U32(file,s+12), size=U32(file,s+16), raw=U32(file,s+20);
                byte[] mapped=Read(process,checked(address+rva),checked((int)size));
                if(delta!=0 && relocSize!=0) {
                    for(int block=reloc;block<checked(reloc+(int)relocSize);) {
                        uint page=U32(file,block), blockSize=U32(file,block+4);
                        if(blockSize<8) throw new InvalidDataException("Invalid relocation block");
                        for(int p=block+8;p<checked(block+(int)blockSize);p+=2) {
                            ushort entry=U16(file,p); uint location=page+(uint)(entry&0xfff); int type=entry>>12;
                            if(location<rva || location>=rva+size || type==0) continue;
                            int at=checked((int)(location-rva)); byte[] value;
                            if(type==10) value=BitConverter.GetBytes(unchecked(BitConverter.ToUInt64(mapped,at)-(ulong)delta));
                            else if(type==3) value=BitConverter.GetBytes(unchecked(U32(mapped,at)-(uint)delta));
                            else throw new InvalidDataException("Unsupported executable relocation");
                            Array.Copy(value,0,mapped,at,value.Length);
                        }
                        block=checked(block+(int)blockSize);
                    }
                }
                for(int p=0;p<mapped.Length;p++) if(mapped[p]!=file[checked((int)raw+p)]) return "stale-mapped-image";
                verified++;
            }
            return verified>0?"mapped-code-matches":"unknown-no-executable-section";
        } finally { CloseHandle(process); }
    }
}

// Native loaded-module discovery supplies a kernel base independently of the
// service configuration and disk filename. The host reads that virtual image
// through the owned VM's QMP connection before assigning a loaded identity.
public sealed class WinBoatKernelModule {
    public string Path { get; set; }
    public string BaseAddress { get; set; }
    public uint ImageSize { get; set; }
    [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int informationClass, IntPtr data, uint length, out uint required);
    public static WinBoatKernelModule[] Query() {
        if (IntPtr.Size!=8) throw new InvalidOperationException("Native x64 module discovery required");
        uint length=1024*1024, required;
        for(int attempt=0;attempt<4;attempt++) {
            IntPtr data=Marshal.AllocHGlobal(checked((int)length));
            try {
                int status=NtQuerySystemInformation(11,data,length,out required);
                if(status==unchecked((int)0xc0000004)) {
                    length=Math.Max(length*2,required);
                    if(length>16*1024*1024) throw new InvalidDataException("Kernel module inventory exceeds bound");
                    continue;
                }
                if(status!=0) throw new IOException("Kernel module discovery NTSTATUS 0x"+status.ToString("x8"));
                int count=Marshal.ReadInt32(data);
                if(count<0 || 8L+count*296L>length) throw new InvalidDataException("Invalid kernel module inventory");
                var selected=new System.Collections.Generic.List<WinBoatKernelModule>();
                for(int i=0;i<count;i++) {
                    IntPtr module=IntPtr.Add(data,8+i*296);
                    string path=Marshal.PtrToStringAnsi(IntPtr.Add(module,40),256).TrimEnd('\0');
                    string name=System.IO.Path.GetFileName(path);
                    if(name.IndexOf("helios",StringComparison.OrdinalIgnoreCase)<0 && name.IndexOf("wbdev-test",StringComparison.OrdinalIgnoreCase)<0) continue;
                    selected.Add(new WinBoatKernelModule { Path=path,
                        BaseAddress=unchecked((ulong)Marshal.ReadInt64(module,16)).ToString("x16"),
                        ImageSize=unchecked((uint)Marshal.ReadInt32(module,24)) });
                }
                return selected.ToArray();
            } finally { Marshal.FreeHGlobal(data); }
        }
        throw new IOException("Kernel module inventory changed repeatedly");
    }
}
