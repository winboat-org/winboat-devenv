/* WinBoatDev provisioning fixture, deliberately independent of Helios. */
#include <ntddk.h>
static void unload(PDRIVER_OBJECT driver) { UNREFERENCED_PARAMETER(driver); }
NTSTATUS DriverEntry(PDRIVER_OBJECT driver, PUNICODE_STRING registry) {
    UNREFERENCED_PARAMETER(registry);
    driver->DriverUnload = unload;
    return STATUS_SUCCESS;
}
