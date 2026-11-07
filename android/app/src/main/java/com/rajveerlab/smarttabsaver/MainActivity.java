package com.rajveerlab.smarttabsaver;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.IOException;

// Smart Tab Saver for Android: shows the phone app (docs/app), bundled in the
// APK and served from a secure local address so its encryption works. Links
// to websites open in the phone's browser.
public class MainActivity extends Activity {
    private static final String HOST = "appassets.androidplatform.net";
    private static final String HOME = "https://" + HOST + "/assets/index.html";
    private static final int BRAND = 0xFF1F6F5C;
    private WebView web;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BRAND);
        web = new WebView(this);
        root.addView(web);
        setContentView(root);
        getWindow().setStatusBarColor(BRAND);
        getWindow().setNavigationBarColor(BRAND);

        // Android 15 draws apps under the system bars: keep the page clear of them.
        if (Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener((v, insets) -> {
                Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return WindowInsets.CONSUMED;
            });
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) c.setSystemBarsAppearance(0, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                    | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
        }

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return asset(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (HOST.equals(url.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (ActivityNotFoundException e) {
                    // no browser: stay in the app
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient());   // shows the app's confirm dialogs

        if (saved != null) web.restoreState(saved);
        else web.loadUrl(HOME);
    }

    // https://appassets.androidplatform.net/assets/<file> -> the bundled file
    private WebResourceResponse asset(Uri url) {
        String path = url.getPath();
        if (!HOST.equals(url.getHost()) || path == null || !path.startsWith("/assets/")) return null;
        String name = path.substring("/assets/".length());
        if (name.isEmpty() || name.contains("..")) return null;
        try {
            return new WebResourceResponse(mime(name), "utf-8", getAssets().open(name));
        } catch (IOException e) {
            WebResourceResponse missing = new WebResourceResponse("text/plain", "utf-8", null);
            missing.setStatusCodeAndReasonPhrase(404, "Not Found");
            return missing;
        }
    }

    private static String mime(String name) {
        if (name.endsWith(".html")) return "text/html";
        if (name.endsWith(".js")) return "text/javascript";
        if (name.endsWith(".css")) return "text/css";
        if (name.endsWith(".png")) return "image/png";
        if (name.endsWith(".webmanifest")) return "application/manifest+json";
        return "application/octet-stream";
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }
}
