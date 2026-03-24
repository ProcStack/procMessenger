package com.procmessenger.app;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * JavaScript bridge that saves a base64-encoded file to the public Downloads directory.
 *
 * Exposed to JavaScript as: window.AndroidDownload.saveFile(base64, fileName, mimeType)
 *
 * API 29+ uses MediaStore (no storage permission needed).
 * API 24-28 writes directly to the public Downloads dir (requires WRITE_EXTERNAL_STORAGE).
 */
public class DownloadBridge {

    private final Context context;

    public DownloadBridge(Context context) {
        this.context = context;
    }

    /**
     * Save a file to the public Downloads directory.
     *
     * @param base64Data Base64-encoded file content.
     * @param fileName   Desired file name (e.g. "procMessenger-1.5.apk").
     * @param mimeType   MIME type (e.g. "application/octet-stream").
     * @return "ok" on success, or an "error: ..." string on failure.
     */
    @JavascriptInterface
    public String saveFile(String base64Data, String fileName, String mimeType) {
        try {
            byte[] bytes = Base64.decode(base64Data, Base64.DEFAULT);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                // API 29+ — MediaStore, no storage permission required
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
                values.put(MediaStore.Downloads.IS_PENDING, 1);

                Uri collection = MediaStore.Downloads.getContentUri(
                        MediaStore.VOLUME_EXTERNAL_PRIMARY);
                Uri itemUri = context.getContentResolver().insert(collection, values);
                if (itemUri == null) {
                    return "error: failed to create MediaStore entry";
                }

                try (OutputStream out = context.getContentResolver().openOutputStream(itemUri)) {
                    if (out == null) {
                        return "error: failed to open output stream";
                    }
                    out.write(bytes);
                }

                // Mark as no longer pending so it appears in Downloads immediately
                values.clear();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                context.getContentResolver().update(itemUri, values, null, null);

            } else {
                // API 24-28 — write directly to public Downloads dir
                File downloadsDir = Environment.getExternalStoragePublicDirectory(
                        Environment.DIRECTORY_DOWNLOADS);
                if (!downloadsDir.exists()) {
                    downloadsDir.mkdirs();
                }
                File outFile = new File(downloadsDir, fileName);
                try (FileOutputStream out = new FileOutputStream(outFile)) {
                    out.write(bytes);
                }
            }

            return "ok";

        } catch (Exception e) {
            return "error: " + e.getMessage();
        }
    }
}
