package com.procmessenger.app;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebChromeClient;
import android.webkit.ConsoleMessage;
import android.util.Log;

import androidx.appcompat.app.AppCompatActivity;

/**
 * MainActivity - Thin WebView wrapper for the procMessenger mobile UI.
 *
 * All UI logic lives in the HTML/CSS/JS assets.
 * This class only sets up the WebView with the necessary permissions.
 */
public class MainActivity extends AppCompatActivity {

    private static final String TAG = "procMessenger";
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        webView = new WebView(this);
        setContentView(webView);

        configureWebView();
        webView.loadUrl("file:///android_asset/index.html");
    }

    private void configureWebView() {
        WebSettings settings = webView.getSettings();

        // Enable JavaScript (required for WebSocket and UI logic)
        settings.setJavaScriptEnabled(true);

        // Allow mixed content for local network connections
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        // DOM storage for local state
        settings.setDomStorageEnabled(true);

        // Prevent navigation away from our app
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                // Only allow loading our local assets
                return !url.startsWith("file:///android_asset/");
            }
        });

        // Forward console.log to Android logcat for debugging
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage consoleMessage) {
                Log.d(TAG, consoleMessage.message()
                        + " -- line " + consoleMessage.lineNumber()
                        + " of " + consoleMessage.sourceId());
                return true;
            }
        });
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
