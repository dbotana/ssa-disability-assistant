cmake_minimum_required(VERSION 3.22.1)
project(ssa_whisper C CXX)

# The speech module's native library. For now it is a probe (whisper_jni.cpp)
# that keeps the NDK build, the alignment audit and the export audit honest
# from the first commit; whisper.cpp is vendored into third_party/ in M1b and
# linked in statically here, so ggml's symbols stay inside this library.

add_compile_options(-Os -fvisibility=hidden -ffunction-sections -fdata-sections)

add_library(whisper_jni SHARED
    whisper_jni.cpp
)

find_library(log-lib log)

target_link_libraries(whisper_jni ${log-lib})

target_link_options(whisper_jni PRIVATE
    # 16 KB page alignment (Android 15+ devices can use 16 KB pages). NDK r28
    # defaults to it; stated here so a toolchain change cannot drop it quietly.
    -Wl,-z,max-page-size=16384
    # Export only the JNI entry points; everything else, ggml included once it
    # lands, stays local. tools/audit-native.sh checks the result.
    -Wl,--version-script=${CMAKE_CURRENT_SOURCE_DIR}/jni.map
    -Wl,--gc-sections
)
set_target_properties(whisper_jni PROPERTIES LINK_DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/jni.map)
