package com.memedrop.app

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.Settings
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.IOException

// Mise à jour de l'APK : le workflow CI publie MemeDrop.apk + version.json
// dans la release "android-latest". On compare son versionCode au nôtre, puis
// on télécharge l'APK via DownloadManager et on lance l'installeur Android.
object Updater {
    private const val BASE = "https://github.com/Billalbzn/memedrop/releases/download/android-latest"
    private const val VERSION_URL = "$BASE/version.json"
    private const val APK_URL = "$BASE/MemeDrop.apk"
    private const val APK_NAME = "MemeDrop-update.apk"

    // idle | checking | up-to-date | available | downloading | downloaded | error
    @Volatile var state = "idle"
    @Volatile var latestName: String? = null
    @Volatile var progress = 0
    @Volatile var error: String? = null
    private var downloadId = -1L

    private val client = OkHttpClient()

    fun toJson(): JSONObject = JSONObject()
        .put("state", state)
        .put("latest", latestName ?: JSONObject.NULL)
        .put("current", BuildConfig.VERSION_NAME)
        .put("progress", progress)
        .put("error", error ?: JSONObject.NULL)

    private fun set(newState: String) {
        state = newState
        Hub.changed()
    }

    // Vérification automatique (manual = false) : silencieuse sauf si une
    // mise à jour est trouvée.
    fun check(manual: Boolean) {
        if (state == "checking" || state == "downloading" || state == "downloaded") return
        if (manual) { error = null; set("checking") }
        Thread {
            try {
                val req = Request.Builder().url(VERSION_URL).header("Cache-Control", "no-cache").build()
                client.newCall(req).execute().use { resp ->
                    if (!resp.isSuccessful) throw IOException("HTTP ${resp.code}")
                    val j = JSONObject(resp.body?.string() ?: "{}")
                    latestName = j.optString("versionName", "")
                    val newer = j.optInt("versionCode", 0) > BuildConfig.VERSION_CODE
                    set(when {
                        newer -> "available"
                        manual -> "up-to-date"
                        else -> "idle"
                    })
                    // "À jour" s'efface tout seul après quelques secondes
                    if (!newer && manual) {
                        Hub.main.postDelayed({ if (state == "up-to-date") set("idle") }, 5_000)
                    }
                }
            } catch (e: Exception) {
                if (manual) { error = e.message ?: "réseau indisponible"; set("error") } else set("idle")
            }
        }.start()
    }

    fun download(ctx: Context) {
        if (state == "downloading") return
        val dm = ctx.getSystemService(DownloadManager::class.java)
        // DownloadManager renomme au lieu d'écraser : on retire l'ancien fichier
        ctx.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)?.let { File(it, APK_NAME).delete() }
        val req = DownloadManager.Request(Uri.parse(APK_URL))
            .setTitle("MemeDrop ${latestName ?: ""}".trim())
            .setDescription("Mise à jour de MemeDrop")
            .setMimeType("application/vnd.android.package-archive")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE)
            .setDestinationInExternalFilesDir(ctx, Environment.DIRECTORY_DOWNLOADS, APK_NAME)
        downloadId = dm.enqueue(req)
        progress = 0
        error = null
        set("downloading")
        poll(ctx.applicationContext)
    }

    // Suit l'avancement du téléchargement (DownloadManager n'a pas de callback
    // de progression) et lance l'installation à la fin.
    private fun poll(ctx: Context) {
        val dm = ctx.getSystemService(DownloadManager::class.java)
        dm.query(DownloadManager.Query().setFilterById(downloadId))?.use { c ->
            if (!c.moveToFirst()) { error = "téléchargement annulé"; set("error"); return }
            val status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
            val done = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
            val total = c.getLong(c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
            when (status) {
                DownloadManager.STATUS_SUCCESSFUL -> {
                    progress = 100
                    set("downloaded")
                    install(ctx)
                    return
                }
                DownloadManager.STATUS_FAILED -> {
                    error = "échec du téléchargement"
                    set("error")
                    return
                }
                else -> {
                    if (total > 0) progress = (done * 100 / total).toInt()
                    Hub.changed()
                }
            }
        }
        Hub.main.postDelayed({ poll(ctx) }, 500)
    }

    fun install(ctx: Context) {
        if (downloadId < 0) return
        // Android 8+ : l'utilisateur doit autoriser MemeDrop à installer des
        // applis une première fois ; il revient ensuite toucher "installer".
        if (Build.VERSION.SDK_INT >= 26 && !ctx.packageManager.canRequestPackageInstalls()) {
            runCatching {
                ctx.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
            return
        }
        val dm = ctx.getSystemService(DownloadManager::class.java)
        val uri = dm.getUriForDownloadedFile(downloadId) ?: run {
            error = "fichier introuvable"; set("error"); return
        }
        runCatching {
            ctx.startActivity(Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK))
        }.onFailure { error = it.message; set("error") }
    }
}
