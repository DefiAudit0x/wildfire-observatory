# Keep WebView JS interface methods
-keepclassmembers class com.observatory.wildfire.WebAppInterface {
    @android.webkit.JavascriptInterface <methods>;
}

# Keep crypto classes
-keep class com.observatory.wildfire.CryptoEngine { *; }
-keep class com.observatory.wildfire.MeshService { *; }

# Spongy Castle
-keep class org.spongycastle.** { *; }
-dontwarn org.spongycastle.**
