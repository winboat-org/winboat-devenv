#include <windows.h>
#include <cstdio>
#include <vector>

int main() {
    const std::vector<int> values{19, 23};
    int result = 0;
    for (int value : values) result += value;
    if (result != 42 || GetModuleHandleW(nullptr) == nullptr) return 1;
    std::printf("{\"state\":\"passed\",\"pointerBits\":%u,\"result\":%d}\n",
                static_cast<unsigned>(sizeof(void*) * 8), result);
    return 0;
}
