package ru.lexin72.semeynayakassa;

import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

/** Atomic SQLite snapshot of rows + pending operations, in private app storage. */
@CapacitorPlugin(name = "FamilyCashDatabase")
public class FamilyCashDatabasePlugin extends Plugin {
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private SQLiteOpenHelper helper;

    @Override public void load() {
        helper = new SQLiteOpenHelper(getContext(), "family-cash.db", null, 1) {
            @Override public void onConfigure(SQLiteDatabase db) {
                db.execSQL("PRAGMA synchronous=FULL");
            }
            @Override public void onCreate(SQLiteDatabase db) {
                db.execSQL("CREATE TABLE snapshot (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)");
            }
            @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
                throw new IllegalStateException("Unsupported database upgrade");
            }
        };
    }

    private String readSnapshot() {
        // CursorWindow has a per-row size limit; read the UTF-8 blob in chunks
        // so years of expenses and profile photos can exceed that limit safely.
        SQLiteDatabase db = helper.getReadableDatabase();
        int size;
        try (Cursor cursor = db.rawQuery("SELECT length(CAST(body AS BLOB)) FROM snapshot WHERE id=1", null)) {
            if (!cursor.moveToFirst()) return null;
            size = cursor.getInt(0);
        }
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream(size);
        for (int offset = 1; offset <= size; offset += 262144) {
            try (Cursor cursor = db.rawQuery("SELECT substr(CAST(body AS BLOB), ?, 262144) FROM snapshot WHERE id=1",
                    new String[]{String.valueOf(offset)})) {
                if (!cursor.moveToFirst()) throw new IllegalStateException("Snapshot disappeared");
                byte[] part = cursor.getBlob(0);
                out.write(part, 0, part.length);
            }
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    @PluginMethod public void load(PluginCall call) {
        worker.execute(() -> {
            try {
                String body = readSnapshot();
                JSObject result = new JSObject();
                result.put("snapshot", body == null ? JSONObject.NULL : body);
                call.resolve(result);
            } catch (Exception error) { call.reject("Cannot read local database", error); }
        });
    }

    @PluginMethod public void save(PluginCall call) {
        String body = call.getString("snapshot");
        if (body == null) { call.reject("Missing snapshot"); return; }
        worker.execute(() -> {
            try {
                JSONObject parsed = new JSONObject(body);
                if (parsed.getInt("version") != 1 || !parsed.has("tables") || !parsed.has("outbox")) {
                    call.reject("Invalid snapshot"); return;
                }
                SQLiteDatabase db = helper.getWritableDatabase();
                db.beginTransaction();
                try {
                    ContentValues values = new ContentValues();
                    values.put("id", 1); values.put("body", body);
                    if (db.insertWithOnConflict("snapshot", null, values, SQLiteDatabase.CONFLICT_REPLACE) < 0) {
                        throw new IllegalStateException("Failed to write snapshot");
                    }
                    db.setTransactionSuccessful();
                } finally { db.endTransaction(); }
                call.resolve();
            } catch (Exception error) { call.reject("Cannot save local database", error); }
        });
    }

    @PluginMethod public void exportBackup(PluginCall call) {
        worker.execute(() -> {
            try {
                String body = readSnapshot();
                if (body == null) { call.reject("Database is empty"); return; }
                File directory = new File(getContext().getCacheDir(), "backups");
                if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("Cannot create backup directory");
                File backup = new File(directory, "semeynaya-kassa-backup.json");
                try (FileOutputStream output = new FileOutputStream(backup)) {
                    output.write(body.getBytes(StandardCharsets.UTF_8));
                }
                android.net.Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", backup);
                Intent intent = new Intent(Intent.ACTION_SEND);
                intent.setType("application/json");
                intent.putExtra(Intent.EXTRA_STREAM, uri);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getActivity().runOnUiThread(() -> {
                    try {
                        getActivity().startActivity(Intent.createChooser(intent, "Сохранить резервную копию"));
                        call.resolve();
                    } catch (Exception error) { call.reject("Cannot share backup", error); }
                });
            } catch (Exception error) { call.reject("Cannot export backup", error); }
        });
    }

    @PluginMethod public void minimize(PluginCall call) {
        getActivity().runOnUiThread(() -> { getActivity().moveTaskToBack(true); call.resolve(); });
    }

    @Override protected void handleOnDestroy() {
        worker.execute(() -> { if (helper != null) helper.close(); });
        worker.shutdown();
    }
}
