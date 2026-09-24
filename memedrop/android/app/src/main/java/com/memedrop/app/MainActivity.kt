package com.memedrop.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import org.json.JSONTokener

// Écran de réglages : une WebView (assets/app.html) qui parle au service via
// le pont JavaScript `MD`.
class MainActivity : Activity() {
    private lateinit var web: WebView
    private val onHubChange = Runnable { pushState() }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Prefs.init(this)

        web = WebView(this)
        web.setBackgroundColor(Color.parseColor("#0B0917"))
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.addJavascriptInterface(Bridge(), "MD")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.scheme == "http" || u.scheme == "https") {
                    runCatching { startActivity(Intent(Intent.ACTION_VIEW, u)) }
                    return true
                }
                return false
            }
        }
        setContentView(web)
        web.loadUrl("file:///android_asset/app.html")

        Hub.addListener(onHubChange)
        startMemeDropService()
    }

    override fun onResume() {
        super.onResume()
        // Retour des écrans système d'autorisation : on rafraîchit l'état
        pushState()
    }

    override fun onDestroy() {
        Hub.removeListener(onHubChange)
        web.destroy()
        super.onDestroy()
    }

    private fun startMemeDropService() {
        runCatching { startForegroundService(Intent(this, MemeDropService::class.java)) }
    }

    private fun pushState() {
        if (::web.isInitialized) {
            web.evaluateJavascript("window.onNativeState && window.onNativeState()", null)
        }
    }

    private fun stateJson(): JSONObject {
        val pm = getSystemService(PowerManager::class.java)
        val notifOk = Build.VERSION.SDK_INT < 33 ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        val perm = JSONObject()
            .put("overlay", Settings.canDrawOverlays(this))
            .put("notif", notifOk)
            .put("battery", pm.isIgnoringBatteryOptimizations(packageName))
        return JSONObject()
            .put("status", Hub.status)
            .put("code", Hub.code ?: JSONObject.NULL)
            .put("user", Hub.user ?: JSONObject.NULL)
            .put("links", Hub.links ?: JSONObject.NULL)
            .put("muteUntil", if (Prefs.isManuallyMuted()) Prefs.muteUntil else 0L)
            .put("quietActive", Prefs.quietHoursActive())
            .put("paused", Prefs.paused)
            .put("serverUrl", Prefs.serverUrl)
            .put("settings", Prefs.settings())
            .put("history", Prefs.history())
            .put("perm", perm)
            .put("version", BuildConfig.VERSION_NAME)
    }

    // Les méthodes @JavascriptInterface tournent sur un thread de la WebView :
    // tout ce qui touche au service ou à l'UI repasse sur le thread principal.
    inner class Bridge {
        @JavascriptInterface
        fun getState(): String = stateJson().toString()

        @JavascriptInterface
        fun setSetting(key: String, valueJson: String) = ui {
            val value = runCatching { JSONTokener(valueJson).nextValue() }.getOrNull()
            if (key == "serverUrl") {
                val url = (value as? String)?.trim() ?: return@ui
                if (!Regex("^wss?://\\S+$", RegexOption.IGNORE_CASE).matches(url)) return@ui
                Prefs.serverUrl = url
                Hub.service?.connect()
            } else {
                Prefs.setSetting(key, value)
                Hub.service?.onSettingChanged()
            }
            Hub.changed()
        }

        @JavascriptInterface
        fun setMute(minutes: Int) = ui {
            val s = Hub.service
            if (s != null) s.setMute(minutes) else {
                Prefs.muteUntil = when {
                    minutes == 0 -> 0L
                    minutes < 0 -> -1L
                    else -> System.currentTimeMillis() + minutes * 60_000L
                }
                Hub.changed()
            }
        }

        @JavascriptInterface
        fun setPaused(paused: Boolean) = ui {
            Prefs.paused = paused
            val s = Hub.service
            if (s != null) s.connect() else if (!paused) startMemeDropService()
            Hub.changed()
        }

        @JavascriptInterface
        fun start() = ui { startMemeDropService() }

        @JavascriptInterface
        fun reconnect() = ui {
            val s = Hub.service
            if (s != null) s.connect() else startMemeDropService()
        }

        @JavascriptInterface
        fun testDrop() = ui {
            if (!Settings.canDrawOverlays(this@MainActivity)) {
                requestOverlayPermission()
                return@ui
            }
            Hub.service?.testDrop()
            // Revenir à l'écran d'accueil pour voir le drop par-dessus
            moveTaskToBack(true)
        }

        @JavascriptInterface
        fun replay(ts: String) = ui {
            val t = ts.toLongOrNull() ?: return@ui
            if (Hub.service?.replay(t) == true) moveTaskToBack(true)
        }

        @JavascriptInterface
        fun clearHistory() = ui {
            Prefs.clearHistory()
            Hub.changed()
        }

        @JavascriptInterface
        fun unlinkGuild(id: String) = ui {
            Hub.service?.send(JSONObject().put("type", "unlink_guild").put("guildId", id))
        }

        @JavascriptInterface
        fun unblockUser(id: String) = ui {
            Hub.service?.send(JSONObject().put("type", "unblock_user").put("userId", id))
        }

        @JavascriptInterface
        fun requestOverlay() = ui { requestOverlayPermission() }

        @JavascriptInterface
        fun requestNotif() = ui {
            if (Build.VERSION.SDK_INT >= 33) {
                requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
            }
        }

        @SuppressLint("BatteryLife")
        @JavascriptInterface
        fun requestBattery() = ui {
            runCatching {
                startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:$packageName")))
            }
        }

        @JavascriptInterface
        fun copy(text: String) = ui {
            val cm = getSystemService(ClipboardManager::class.java)
            cm.setPrimaryClip(ClipData.newPlainText("MemeDrop", text))
        }

        @JavascriptInterface
        fun openUrl(url: String) = ui {
            if (url.startsWith("https://") || url.startsWith("http://")) {
                runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
            }
        }

        private fun ui(block: () -> Unit) {
            runOnUiThread(block)
        }
    }

    private fun requestOverlayPermission() {
        runCatching {
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:$packageName")))
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        pushState()
    }
}
