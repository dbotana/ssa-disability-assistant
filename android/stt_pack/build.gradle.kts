// Install-time pack holding the Whisper model (ggml-base.en q8_0, ~80 MB).
// Delivered inside the split APKs, so there is no plain file path to mmap:
// whisper.cpp is patched to read through its loader-callback API instead.
plugins {
    alias(libs.plugins.android.assetpack)
}

assetPack {
    packName = "stt_pack"
    dynamicDelivery {
        deliveryType = "install-time"
    }
}
