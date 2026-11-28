#!/usr/bin/env python3
"""Write ios/App/SsaAssistant.xcodeproj, deterministically.

    python3 ios/tools/gen-xcodeproj.py           # write the project
    python3 ios/tools/gen-xcodeproj.py --check   # exit 1 when it is stale

No XcodeGen and no Tuist: this is stdlib Python, and the project it writes is
committed beside the generator. Everything that varies per machine -- a signing
team, a UDID, an Apple ID, a device name -- is *not* written here; the owner
passes DEVELOPMENT_TEAM on the command line.

The project has an app target (SsaAssistant, iOS 17, iPhone, bundle id
org.ssa.assistant.ios), a unit-test bundle and a UI-test bundle, the local
Swift package ../CoreCrypto (its product SsaKit, which holds the CoreCrypto and
SsaPdf targets, so the process gets one copy of SsaCore), which also
brings ONNX Runtime: the package's `onnxruntime` binary target, a copy of the
pinned xcframework that :ui:assembleSsaCoreDebugXCFramework puts beside
SsaCore. The app must not link ORT a second time ("Multiple commands produce
onnxruntime.framework"). A shell-script phase
stages the pinned resources into the bundle's SsaResources/ folder at build
time (ios/App/README.md records the layout).

Source lists are the sorted contents of each source folder, so adding a Swift
file means running this generator again; --check says when it is stale.
"""
import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
IOS = os.path.dirname(HERE)
APP = os.path.join(IOS, "App")
PROJECT = os.path.join(APP, "SsaAssistant.xcodeproj")

APP_SOURCES_DIR = os.path.join(APP, "SsaAssistant")
TEST_SOURCES_DIR = os.path.join(APP, "SsaAssistantTests")
UI_TEST_SOURCES_DIR = os.path.join(APP, "SsaAssistantUITests")

APP_NAME = "SsaAssistant"
BUNDLE_ID = "org.ssa.assistant.ios"
DEPLOYMENT_TARGET = "17.0"

# The shell that stages ios/App/SsaResources.SHA256SUMS-checked resources into
# the app bundle. Every copy is from the repository, never from the network.
STAGE_RESOURCES = r"""set -e
SRC="${SRCROOT}/../.."
DEST="${BUILT_PRODUCTS_DIR}/${UNLOCALIZED_RESOURCES_FOLDER_PATH}/SsaResources"
rm -rf "$DEST"
mkdir -p "$DEST/golden" "$DEST/forms" "$DEST/vendor" "$DEST/models"
cp "$SRC/tools/schema.json" "$DEST/schema.json"
cp "$SRC/android/core/src/commonMain/resources/golden/metrics.json" "$DEST/golden/metrics.json"
cp "$SRC/android/core/src/commonMain/resources/golden/templateManifest.json" "$DEST/golden/templateManifest.json"
cp "$SRC/forms/ssa-adult-disability-starter-kit-64-110.pdf" "$DEST/forms/ssa-adult-disability-starter-kit-64-110.pdf"
cp "$SRC/forms/maine-developmental-services-intake-2025-06-18.pdf" "$DEST/forms/maine-developmental-services-intake-2025-06-18.pdf"
cp "$SRC/android/pdf/forms.SHA256SUMS" "$DEST/forms/SHA256SUMS"
cp "$SRC/vendor/pdf-lib.min.js" "$DEST/vendor/pdf-lib.min.js"
cp "$SRC/vendor/ssa-pdf-writer.js" "$DEST/vendor/ssa-pdf-writer.js"
cp "$SRC/vendor/SHA256SUMS" "$DEST/vendor/SHA256SUMS"
rsync -a --delete "$SRC/models/whisper-base.en/" "$DEST/models/whisper-base.en/" --exclude '.venv'
cp "$SRC/ios/App/SsaResources.SHA256SUMS" "$DEST/SsaResources.SHA256SUMS"
"""


def oid(name):
    """A stable 24-hex object id: the same name always gets the same id."""
    return hashlib.sha1(name.encode("utf-8")).hexdigest()[:24].upper()


def swift_files(directory):
    if not os.path.isdir(directory):
        return []
    return sorted(n for n in os.listdir(directory) if n.endswith(".swift"))


class Project:
    def __init__(self):
        self.objects = []

    def add(self, name, body):
        identifier = oid(name)
        self.objects.append((identifier, body))
        return identifier

    def ref(self, name):
        return oid(name)


def q(value):
    return '"%s"' % value


def settings(pairs):
    return "{" + " ".join("%s = %s;" % (k, v) for k, v in pairs) + "}"


def build():
    p = Project()
    app_sources = swift_files(APP_SOURCES_DIR)
    test_sources = swift_files(TEST_SOURCES_DIR)
    ui_test_sources = swift_files(UI_TEST_SOURCES_DIR)
    if not app_sources:
        raise SystemExit("no Swift sources in %s" % APP_SOURCES_DIR)

    # -- file references -----------------------------------------------------
    def source_refs(folder, names):
        refs = []
        for name in names:
            refs.append(p.add(
                "ref:%s/%s" % (folder, name),
                "{isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = %s; sourceTree = \"<group>\"; }" % name,
            ))
        return refs

    app_refs = source_refs("app", app_sources)
    test_refs = source_refs("tests", test_sources)
    ui_test_refs = source_refs("uitests", ui_test_sources)

    app_product = p.add(
        "prod:app",
        "{isa = PBXFileReference; explicitFileType = wrapper.application; includeInIndex = 0; path = %s.app; sourceTree = BUILT_PRODUCTS_DIR; }" % APP_NAME,
    )
    test_product = p.add(
        "prod:tests",
        "{isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = %sTests.xctest; sourceTree = BUILT_PRODUCTS_DIR; }" % APP_NAME,
    )
    ui_test_product = p.add(
        "prod:uitests",
        "{isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = %sUITests.xctest; sourceTree = BUILT_PRODUCTS_DIR; }" % APP_NAME,
    )

    # -- the local Swift package and its one product -------------------------
    # One product, not CoreCrypto and SsaPdf separately: Xcode makes each
    # product a dynamic framework when the app and its test bundle both use it,
    # and two products meant two copies of the static SsaCore, two Kotlin
    # runtimes, and a crash at launch (Package.swift, SsaKit).
    package = p.add("pkg:CoreCrypto", "{isa = XCLocalSwiftPackageReference; relativePath = ../CoreCrypto; }")
    products = ["SsaKit"]
    deps = {
        name: p.add("dep:%s" % name, "{isa = XCSwiftPackageProductDependency; package = %s; productName = %s; }" % (package, name))
        for name in products
    }

    # -- build files ---------------------------------------------------------
    app_build_files = [
        p.add("bf:app:%s" % name, "{isa = PBXBuildFile; fileRef = %s; }" % p.ref("ref:app/%s" % name))
        for name in app_sources
    ]
    test_build_files = [
        p.add("bf:tests:%s" % name, "{isa = PBXBuildFile; fileRef = %s; }" % p.ref("ref:tests/%s" % name))
        for name in test_sources
    ]
    ui_test_build_files = [
        p.add("bf:uitests:%s" % name, "{isa = PBXBuildFile; fileRef = %s; }" % p.ref("ref:uitests/%s" % name))
        for name in ui_test_sources
    ]
    dep_build_files = {
        name: p.add("bf:dep:%s" % name, "{isa = PBXBuildFile; productRef = %s; }" % deps[name])
        for name in products
    }

    # -- groups --------------------------------------------------------------
    app_group = p.add(
        "group:app",
        "{isa = PBXGroup; children = (%s); path = %s; sourceTree = \"<group>\"; }"
        % (", ".join(app_refs), APP_NAME),
    )
    test_group = p.add(
        "group:tests",
        "{isa = PBXGroup; children = (%s); path = %sTests; sourceTree = \"<group>\"; }"
        % (", ".join(test_refs), APP_NAME),
    )
    ui_test_group = p.add(
        "group:uitests",
        "{isa = PBXGroup; children = (%s); path = %sUITests; sourceTree = \"<group>\"; }"
        % (", ".join(ui_test_refs), APP_NAME),
    )
    products_group = p.add(
        "group:products",
        "{isa = PBXGroup; children = (%s, %s, %s); name = Products; sourceTree = \"<group>\"; }"
        % (app_product, test_product, ui_test_product),
    )
    main_group = p.add(
        "group:main",
        "{isa = PBXGroup; children = (%s, %s, %s, %s); sourceTree = \"<group>\"; }"
        % (app_group, test_group, ui_test_group, products_group),
    )

    # -- phases --------------------------------------------------------------
    def sources_phase(name, refs):
        return p.add(name, "{isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (%s); runOnlyForDeploymentPostprocessing = 0; }" % ", ".join(refs))

    def frameworks_phase(name, refs):
        return p.add(name, "{isa = PBXFrameworksBuildPhase; buildActionMask = 2147483647; files = (%s); runOnlyForDeploymentPostprocessing = 0; }" % ", ".join(refs))

    def resources_phase(name):
        return p.add(name, "{isa = PBXResourcesBuildPhase; buildActionMask = 2147483647; files = (); runOnlyForDeploymentPostprocessing = 0; }")

    app_sources_phase = sources_phase("phase:app:sources", app_build_files)
    app_frameworks_phase = frameworks_phase("phase:app:frameworks", list(dep_build_files.values()))
    app_resources_phase = resources_phase("phase:app:resources")

    stage_script = p.add(
        "phase:app:stage-resources",
        "{isa = PBXShellScriptBuildPhase; alwaysOutOfDate = 1; buildActionMask = 2147483647; "
        "files = (); inputFileListPaths = (); inputPaths = (); name = \"Stage pinned resources\"; "
        "outputFileListPaths = (); outputPaths = (); runOnlyForDeploymentPostprocessing = 0; "
        "shellPath = /bin/sh; shellScript = %s; }" % q(STAGE_RESOURCES.replace("\n", "\\n").replace('"', '\\"')),
    )

    test_sources_phase = sources_phase("phase:tests:sources", test_build_files)
    # The package products are in the test target's `packageProductDependencies`
    # (so its Swift files can `import SsaCore`, `SsaPdf` and `CoreCrypto`), but
    # nothing is linked into it: SsaCore is static and the app binary already
    # carries the one Kotlin runtime, which `TEST_HOST`/`BUNDLE_LOADER` resolve
    # against. Linking it twice is what B3 exists to prevent.
    test_frameworks_phase = frameworks_phase("phase:tests:frameworks", [])
    test_resources_phase = resources_phase("phase:tests:resources")

    ui_test_sources_phase = sources_phase("phase:uitests:sources", ui_test_build_files)
    ui_test_frameworks_phase = frameworks_phase("phase:uitests:frameworks", [])
    ui_test_resources_phase = resources_phase("phase:uitests:resources")

    # -- build configurations -------------------------------------------------
    common = [
        ("SDKROOT", q("iphoneos")),
        ("IPHONEOS_DEPLOYMENT_TARGET", q(DEPLOYMENT_TARGET)),
        ("SWIFT_VERSION", q("5.0")),
        ("TARGETED_DEVICE_FAMILY", q("1")),
        ("ENABLE_TESTABILITY", "YES"),
        ("CLANG_ENABLE_MODULES", "YES"),
        ("SWIFT_OPTIMIZATION_LEVEL", q("-Onone")),
        ("SWIFT_ACTIVE_COMPILATION_CONDITIONS", q("DEBUG")),
        ("DEBUG_INFORMATION_FORMAT", q("dwarf")),
        ("GCC_OPTIMIZATION_LEVEL", q("0")),
        ("CODE_SIGN_STYLE", q("Automatic")),
    ]

    def config(name, pairs):
        return p.add(
            "cfg:%s" % name,
            "{isa = XCBuildConfiguration; buildSettings = %s; name = Debug; }" % settings(pairs),
        )

    project_debug = config("project", common + [("ONLY_ACTIVE_ARCH", "YES")])

    app_debug = config("app", [
        ("PRODUCT_NAME", q("$(TARGET_NAME)")),
        ("PRODUCT_BUNDLE_IDENTIFIER", q(BUNDLE_ID)),
        ("GENERATE_INFOPLIST_FILE", "YES"),
        # Merged with the generated keys: CADisableMinimumFrameDurationOnPhone,
        # which Compose Multiplatform requires and INFOPLIST_KEY_* cannot set.
        ("INFOPLIST_FILE", q("SsaAssistant/Info.plist")),
        ("INFOPLIST_KEY_CFBundleDisplayName", q("Forms Assistant")),
        ("INFOPLIST_KEY_UILaunchScreen_Generation", "YES"),
        ("INFOPLIST_KEY_UIApplicationSceneManifest_Generation", "YES"),
        ("INFOPLIST_KEY_NSMicrophoneUsageDescription", q("The microphone lets you answer questions by voice. Nothing is recorded or sent unless you press Talk.")),
        ("LD_RUNPATH_SEARCH_PATHS", q("$(inherited) @executable_path/Frameworks")),
        ("CURRENT_PROJECT_VERSION", q("1")),
        ("MARKETING_VERSION", q("1.0")),
    ])

    test_debug = config("tests", [
        ("PRODUCT_NAME", q("$(TARGET_NAME)")),
        ("PRODUCT_BUNDLE_IDENTIFIER", q(BUNDLE_ID + ".tests")),
        ("GENERATE_INFOPLIST_FILE", "YES"),
        ("TEST_HOST", q("$(BUILT_PRODUCTS_DIR)/%s.app/$(BUNDLE_EXECUTABLE_FOLDER_PATH)/%s" % (APP_NAME, APP_NAME))),
        ("BUNDLE_LOADER", q("$(TEST_HOST)")),
        ("LD_RUNPATH_SEARCH_PATHS", q("$(inherited) @executable_path/Frameworks @loader_path/Frameworks")),
    ])

    ui_test_debug = config("uitests", [
        ("PRODUCT_NAME", q("$(TARGET_NAME)")),
        ("PRODUCT_BUNDLE_IDENTIFIER", q(BUNDLE_ID + ".uitests")),
        ("GENERATE_INFOPLIST_FILE", "YES"),
        ("TEST_TARGET_NAME", q(APP_NAME)),
        ("LD_RUNPATH_SEARCH_PATHS", q("$(inherited) @executable_path/Frameworks @loader_path/Frameworks")),
    ])

    def config_list(name, configs):
        return p.add(
            "list:%s" % name,
            "{isa = XCConfigurationList; buildConfigurations = (%s); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; }"
            % ", ".join(configs),
        )

    project_list = config_list("project", [project_debug])
    app_list = config_list("app", [app_debug])
    test_list = config_list("tests", [test_debug])
    ui_test_list = config_list("uitests", [ui_test_debug])

    # -- targets --------------------------------------------------------------
    app_target = p.ref("target:app")
    test_target = p.ref("target:tests")
    ui_test_target = p.ref("target:uitests")

    def proxy(name, target, remote):
        return p.add(
            "proxy:%s" % name,
            "{isa = PBXContainerItemProxy; containerPortal = %s; proxyType = 1; remoteGlobalIDString = %s; remoteInfo = %s; }"
            % (p.ref("project"), target, remote),
        )

    def dependency(name, target, remote):
        return p.add(
            "tdep:%s" % name,
            "{isa = PBXTargetDependency; target = %s; targetProxy = %s; }"
            % (target, proxy(name, target, remote)),
        )

    test_dependency = dependency("tests", app_target, APP_NAME)
    ui_test_dependency = dependency("uitests", app_target, APP_NAME)

    p.add(
        "target:app",
        "{isa = PBXNativeTarget; buildConfigurationList = %s; buildPhases = (%s, %s, %s, %s); "
        "buildRules = (); dependencies = (); name = %s; packageProductDependencies = (%s); "
        "productName = %s; productReference = %s; productType = \"com.apple.product-type.application\"; }"
        % (app_list, app_sources_phase, app_frameworks_phase, app_resources_phase, stage_script,
           APP_NAME, ", ".join(deps.values()), APP_NAME, app_product),
    )
    p.add(
        "target:tests",
        "{isa = PBXNativeTarget; buildConfigurationList = %s; buildPhases = (%s, %s, %s); "
        "buildRules = (); dependencies = (%s); name = %sTests; packageProductDependencies = (%s); "
        "productName = %sTests; productReference = %s; productType = \"com.apple.product-type.bundle.unit-test\"; }"
        % (test_list, test_sources_phase, test_frameworks_phase, test_resources_phase,
           test_dependency, APP_NAME, ", ".join(deps.values()), APP_NAME, test_product),
    )
    p.add(
        "target:uitests",
        "{isa = PBXNativeTarget; buildConfigurationList = %s; buildPhases = (%s, %s, %s); "
        "buildRules = (); dependencies = (%s); name = %sUITests; "
        "productName = %sUITests; productReference = %s; productType = \"com.apple.product-type.bundle.ui-testing\"; }"
        % (ui_test_list, ui_test_sources_phase, ui_test_frameworks_phase, ui_test_resources_phase,
           ui_test_dependency, APP_NAME, APP_NAME, ui_test_product),
    )

    p.add(
        "project",
        "{isa = PBXProject; attributes = {BuildIndependentTargetsInParallel = 1; LastUpgradeCheck = 2700; "
        "TargetAttributes = {%s = {TestTargetID = %s; }; %s = {TestTargetID = %s; }; }; }; "
        "buildConfigurationList = %s; compatibilityVersion = \"Xcode 14.0\"; developmentRegion = en; "
        "hasScannedForEncodings = 0; knownRegions = (en, Base); mainGroup = %s; "
        "packageReferences = (%s); productRefGroup = %s; projectDirPath = \"\"; projectRoot = \"\"; "
        "targets = (%s, %s, %s); }"
        % (test_target, app_target, ui_test_target, app_target, project_list, main_group,
           package, products_group, app_target, test_target, ui_test_target),
    )

    text = "// !$*UTF8*$!\n{\n\tarchiveVersion = 1;\n\tclasses = {};\n\tobjectVersion = 60;\n\tobjects = {\n"
    for identifier, body in p.objects:
        text += "\t\t%s = %s;\n" % (identifier, body)
    text += "\t};\n\trootObject = %s;\n}\n" % p.ref("project")

    scheme = scheme_text(app_target, test_target, ui_test_target)
    return {
        "project.pbxproj": text,
        "xcshareddata/xcschemes/%s.xcscheme" % APP_NAME: scheme,
    }


def scheme_reference(target, name, product):
    return (
        '<BuildableReference BuildableIdentifier = "primary" BlueprintIdentifier = "%s" '
        'BuildableName = "%s" BlueprintName = "%s" ReferencedContainer = "container:%s.xcodeproj"></BuildableReference>'
        % (target, product, name, APP_NAME)
    )


def scheme_text(app_target, test_target, ui_test_target):
    return """<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion = "2700" version = "1.7">
   <BuildAction parallelizeBuildables = "YES" buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry buildForTesting = "YES" buildForRunning = "YES" buildForProfiling = "NO" buildForArchiving = "NO" buildForAnalyzing = "NO">
            %s
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <TestAction buildConfiguration = "Debug" selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB" selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB" shouldUseLaunchSchemeArgsEnv = "YES">
      <Testables>
         <TestableReference skipped = "NO">
            %s
         </TestableReference>
         <TestableReference skipped = "NO">
            %s
         </TestableReference>
      </Testables>
   </TestAction>
   <LaunchAction buildConfiguration = "Debug" launchStyle = "0" useCustomWorkingDirectory = "NO" debugDocumentVersioning = "YES">
      <BuildableProductRunnable runnableDebuggingMode = "0">
         %s
      </BuildableProductRunnable>
   </LaunchAction>
</Scheme>
""" % (
        scheme_reference(app_target, APP_NAME, APP_NAME + ".app"),
        scheme_reference(test_target, APP_NAME + "Tests", APP_NAME + "Tests.xctest"),
        scheme_reference(ui_test_target, APP_NAME + "UITests", APP_NAME + "UITests.xctest"),
        scheme_reference(app_target, APP_NAME, APP_NAME + ".app"),
    )


def main(argv):
    files = build()
    check = "--check" in argv
    stale = []
    for relative, text in files.items():
        path = os.path.join(PROJECT, relative)
        existing = None
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8", newline="") as handle:
                existing = handle.read()
        if existing != text:
            stale.append(relative)
            if not check:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w", encoding="utf-8", newline="") as handle:
                    handle.write(text)
    if check:
        if stale:
            print("stale: " + ", ".join(stale))
            print("run python3 ios/tools/gen-xcodeproj.py")
            return 1
        print("xcodeproj up to date")
        return 0
    print("wrote %s (%s)" % (PROJECT, ", ".join(sorted(files))))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
