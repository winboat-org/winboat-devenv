/* Prebuilt catalog membership verifier. Produced by the Helios component job;
 * release assembly executes this binary and never compiles a verifier DLL. */
#define _WIN32_WINNT 0x0602
#include <windows.h>
#include <wincrypt.h>
#include <mscat.h>
#include <stdio.h>
#include <wchar.h>

int wmain(int argc, wchar_t **argv) {
    if (argc == 2 && wcscmp(argv[1], L"--interface") == 0) {
        puts("{\"interfaceVersion\":1}");
        return 0;
    }
    if (argc != 3) return 87;
    HANDLE catalog = CryptCATOpen(argv[1], 0, 0, 0, 0);
    if (catalog == INVALID_HANDLE_VALUE || catalog == NULL) return 74;
    HCATADMIN context = NULL;
    if (!CryptCATAdminAcquireContext2(&context, NULL, L"SHA256", NULL, 0)) {
        CryptCATClose(catalog);
        return 74;
    }
    const wchar_t *names[] = {
        L"helios_kmd_render.sys", L"helios_umd.dll", L"helios_umd12.dll",
        L"helios_umd32.dll", L"helios_umd12_32.dll"
    };
    int status = 0;
    for (unsigned i = 0; i < sizeof(names) / sizeof(names[0]); ++i) {
        wchar_t filename[32768];
        if (swprintf_s(filename, sizeof(filename) / sizeof(filename[0]),
                       L"%ls\\%ls", argv[2], names[i]) < 0) { status = 74; break; }
        HANDLE input = CreateFileW(filename, GENERIC_READ, FILE_SHARE_READ,
                                  NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        if (input == INVALID_HANDLE_VALUE) { status = 74; break; }
        BYTE hash[32]; DWORD size = sizeof(hash);
        BOOL hashed = CryptCATAdminCalcHashFromFileHandle2(context, input, &size, hash, 0);
        CloseHandle(input);
        if (!hashed || size != sizeof(hash)) { status = 74; break; }
        wchar_t tag[65];
        for (unsigned j = 0; j < sizeof(hash); ++j)
            swprintf_s(tag + j * 2, 3, L"%02X", hash[j]);
        BOOL found = FALSE;
        CRYPTCATMEMBER *member = NULL;
        while ((member = CryptCATEnumerateMember(catalog, member)) != NULL) {
            if (member->pwszReferenceTag && _wcsicmp(member->pwszReferenceTag, tag) == 0) {
                found = TRUE; break;
            }
        }
        if (!found) { fwprintf(stderr, L"Catalog omits exact %ls bytes\n", names[i]); status = 74; break; }
    }
    CryptCATAdminReleaseContext(context, 0);
    CryptCATClose(catalog);
    if (!status) puts("{\"catalogMembers\":5,\"state\":\"verified\"}");
    return status;
}
