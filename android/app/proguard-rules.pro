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
