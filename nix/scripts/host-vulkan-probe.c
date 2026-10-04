#include <stdio.h>
#include <vulkan/vulkan.h>

int main(void)
{
    VkApplicationInfo app = { .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO,
                              .pApplicationName = "WinBoat host probe",
                              .apiVersion = VK_API_VERSION_1_3 };
    VkInstanceCreateInfo info = { .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO,
                                 .pApplicationInfo = &app };
    VkInstance instance;
    VkResult result = vkCreateInstance(&info, NULL, &instance);
    if (result != VK_SUCCESS) {
        fprintf(stderr, "Host vkCreateInstance failed: %d\n", result);
        return 1;
    }
    uint32_t devices = 0;
    result = vkEnumeratePhysicalDevices(instance, &devices, NULL);
    vkDestroyInstance(instance, NULL);
    if (result != VK_SUCCESS || !devices) {
        fprintf(stderr, "Host Vulkan has no usable physical device: %d\n", result);
        return 2;
    }
    printf("{\"state\":\"available\",\"physicalDevices\":%u,\"apiVersion\":%u}\n",
           devices, app.apiVersion);
    return 0;
}
