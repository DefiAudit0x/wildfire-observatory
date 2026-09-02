# v2.0.0: the WebView JS bridge is GONE (no WebView in the app anymore) —
# the old WebAppInterface keep rules were deleted with it.
#
# The service classes are named from AndroidManifest.xml; keep their
# constructors, but allow R8 to remove/rename unrelated implementation details.
-keep class com.observatory.wildfire.MeshService extends android.app.Service {
    public <init>();
}
-keep class com.observatory.wildfire.TeamLocationService extends android.app.Service {
    public <init>();
}

# osmdroid resolves tile sources and modules reflectively in a few paths;
# blanket-keep for reliability (the library is ~2MB unminified, acceptable).
-keep class org.osmdroid.** { *; }
-dontwarn org.osmdroid.**

# NOTE (v1.0.3): no bouncycastle rules — no bundled BC provider ships since
# v1.0.3 (see CryptoProviderContractTest for the contract).
