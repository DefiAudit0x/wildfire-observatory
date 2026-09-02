# Keep WebView JS interface methods
# Keep only the public JavaScript bridge surface. CryptoEngine is referenced
# directly from Kotlin and does not require a blanket keep rule.
-keep class com.observatory.wildfire.WebAppInterface {
    public <init>(...);
}
-keepclassmembers class com.observatory.wildfire.WebAppInterface {
    @android.webkit.JavascriptInterface <methods>;
}

# The service class is named from AndroidManifest.xml; keep its constructor,
# but allow R8 to remove/rename unrelated implementation details.
-keep class com.observatory.wildfire.MeshService extends android.app.Service {
    public <init>();
}

# NOTE (v1.0.3): the org.bouncycastle keep rules were removed together with
# the bundled bcprov dependency — no bouncycastle classes ship in the APK
# anymore. History for future maintainers: those rules guarded the bundled
# provider that was registered via Security.insertProviderAt in MeshService;
# the registration always silently failed on Android (duplicate "BC" name)
# and the dependency is gone — see CryptoProviderContractTest.
