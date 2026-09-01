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

# Bouncy Castle (bundled JCE provider, registered programmatically in
# MeshService via Security.insertProviderAt): the provider resolves its
# algorithm implementations by CLASS NAME — string-driven reflective
# instantiation inside the provider itself and in the JCA framework's
# service lookup. R8 renaming/stripping these trees produces an app that
# builds clean and breaks at FIRST crypto use — invisible to the debug
# build (minifyEnabled false), which is exactly why these rules must
# live here and be exercised by the CI release job.
-keep class org.bouncycastle.jce.provider.** { *; }
-keep class org.bouncycastle.jcajce.provider.** { *; }
-dontwarn org.bouncycastle.**
