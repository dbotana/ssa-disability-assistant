// Fast-follow pack for the optional LLM (Qwen3 ~0.6B Q4, if the eval in
// tools/llm-eval passes its ship gates). Not in :app's assetPacks yet.
//
// The plan delivers it only to devices with >= 6 GB RAM, the llmCapable group
// of app/device_targeting_config.xml. A plain asset pack cannot be targeted
// that way: tried with a models#group_llmCapable/ folder and bundle
// deviceGroup splitting enabled, bundletool 1.17.2 rejects the bundle
// ("Directory 'models' contains unsupported key 'group'") — its folder keys
// are lang, tcf, tier and countries. Group-targeted model folders belong to
// Play's AI packs (the com.android.ai-pack plugin and a newer bundletool),
// which is what the plan specifies; this module moves to that in M6/M7. Also
// still open (the plan's spike): whether fast-follow delivery needs a library
// that brings a network permission.
plugins {
    alias(libs.plugins.android.assetpack)
}

assetPack {
    packName = "llm_pack"
    dynamicDelivery {
        deliveryType = "fast-follow"
    }
}
