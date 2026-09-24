package com.memedrop.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Build
import android.os.IBinder
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

// Service de premier plan : garde la connexion au bot (même protocole que
// l'overlay Windows) et affiche les drops reçus via OverlayController.
class MemeDropService : Service() {

    companion object {
        const val ACTION_MUTE = "com.memedrop.app.MUTE"
        const val ACTION_UNMUTE = "com.memedrop.app.UNMUTE"
        const val ACTION_STOP = "com.memedrop.app.STOP"
        private const val CHANNEL = "memedrop"
        private const val NOTIF_ID = 1
        // Le bot envoie un ping toutes les 30 s : sans nouvelles pendant 75 s,
        // la connexion est considérée morte et on se reconnecte.
        private const val HEARTBEAT_TIMEOUT_MS = 75_000L
    }

    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private var ws: WebSocket? = null
    private var attempts = 0
    private lateinit var overlay: OverlayController
    private var lastMuteKey = ""

    private val reconnectRunnable = Runnable { connect() }
    private val heartbeatRunnable = Runnable { ws?.cancel() }
    private val muteTicker = object : Runnable {
        override fun run() {
            val key = "${Prefs.isManuallyMuted()}|${Prefs.quietHoursActive()}"
            if (key != lastMuteKey) {
                lastMuteKey = key
                updateNotification()
                Hub.changed()
            }
            Hub.main.postDelayed(this, 30_000L)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        Prefs.init(this)
        overlay = OverlayController(this)
        Hub.service = this
        createChannel()
        val n = buildNotification()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        } else {
            startForeground(NOTIF_ID, n)
        }
        Hub.main.post(muteTicker)
        connect()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_MUTE -> setMute(60)
            ACTION_UNMUTE -> setMute(0)
            ACTION_STOP -> {
                stopEverything()
                return START_NOT_STICKY
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        Hub.main.removeCallbacks(reconnectRunnable)
        Hub.main.removeCallbacks(heartbeatRunnable)
        Hub.main.removeCallbacks(muteTicker)
        dropSocket()
        overlay.destroy()
        if (Hub.service === this) Hub.service = null
        Hub.status = "stopped"
        Hub.code = null
        Hub.user = null
        Hub.links = null
        Hub.changed()
        super.onDestroy()
    }

    private fun stopEverything() {
        @Suppress("DEPRECATION")
        stopForeground(true)
        stopSelf()
    }

    // ── Connexion ─────────────────────────────────────────────────────────

    fun connect() {
        Hub.main.removeCallbacks(reconnectRunnable)
        dropSocket()
        if (Prefs.paused) {
            setState("paused", null, null, null)
            return
        }
        setState("connecting", null, null, null)

        val request = try {
            Request.Builder().url(Prefs.serverUrl).build()
        } catch (e: IllegalArgumentException) {
            setState("disconnected", null, null, null)
            scheduleReconnect()
            return
        }
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Hub.main.post { if (webSocket === ws) onSocketOpen() }
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                Hub.main.post { if (webSocket === ws) onSocketMessage(text) }
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Hub.main.post { if (webSocket === ws) onSocketClosed() }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Hub.main.post { if (webSocket === ws) onSocketClosed() }
            }
        })
    }

    // Ferme la socket courante sans déclencher de reconnexion (les callbacks
    // ignorent toute socket qui n'est plus `ws`).
    private fun dropSocket() {
        Hub.main.removeCallbacks(heartbeatRunnable)
        val old = ws
        ws = null
        old?.cancel()
    }

    private fun scheduleReconnect() {
        Hub.main.removeCallbacks(reconnectRunnable)
        attempts++
        val delay = minOf(30_000.0, 1000.0 * Math.pow(1.6, minOf(attempts, 8).toDouble())).toLong()
        Hub.main.postDelayed(reconnectRunnable, delay)
    }

    private fun armHeartbeat() {
        Hub.main.removeCallbacks(heartbeatRunnable)
        Hub.main.postDelayed(heartbeatRunnable, HEARTBEAT_TIMEOUT_MS)
    }

    fun send(payload: JSONObject): Boolean = ws?.send(payload.toString()) ?: false

    private fun onSocketOpen() {
        attempts = 0
        armHeartbeat()
        // Ré-enregistrement automatique avec l'identité stockée (pas de /link)
        val identity = Prefs.linkIdentity
        if (identity != null && identity.optString("userId").isNotEmpty()) {
            send(JSONObject().put("type", "register").put("identity", identity))
        }
    }

    private fun onSocketClosed() {
        Hub.main.removeCallbacks(heartbeatRunnable)
        ws = null
        if (Prefs.paused) {
            setState("paused", null, null, null)
            return
        }
        setState("disconnected", null, null, null)
        scheduleReconnect()
    }

    private fun onSocketMessage(text: String) {
        armHeartbeat()
        val msg = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (msg.optString("type")) {
            "pairing_code" -> {
                val code = msg.optString("code")
                when {
                    // Déjà lié : code d'extension pour ajouter un serveur
                    Hub.status == "linked" -> setState("linked", code, Hub.user, Hub.links)
                    // Ré-enregistrement silencieux en cours
                    Prefs.linkIdentity != null -> setState("connecting", code, null, null)
                    else -> setState("awaiting_link", code, null, null)
                }
            }
            "linked" -> {
                val user = msg.optJSONObject("user")
                val links = msg.optJSONObject("links") ?: JSONObject().put("scope", "guild")
                if (user != null && user.optString("id").isNotEmpty()) {
                    Prefs.linkIdentity = JSONObject()
                        .put("userId", user.optString("id"))
                        .put("username", user.optString("username"))
                        .put("scope", if (links.optString("scope") == "global") "global" else "guild")
                        .put("guildIds", links.optJSONArray("guildIds") ?: JSONArray())
                        .put("token", if (msg.isNull("token")) JSONObject.NULL else msg.optString("token"))
                        .put("blockedIds", links.optJSONArray("blockedIds") ?: JSONArray())
                }
                setState("linked", null, user, links)
            }
            "register_failed" -> {
                // Identité invalide/obsolète : on l'oublie et on repasse en appairage
                Prefs.linkIdentity = null
                setState("awaiting_link", Hub.code, null, null)
            }
            "links_update" -> {
                val links = msg.optJSONObject("links")
                val cur = Prefs.linkIdentity
                if (cur != null && links != null) {
                    cur.put("scope", if (links.optString("scope") == "global") "global" else "guild")
                    links.optJSONArray("guildIds")?.let { cur.put("guildIds", it) }
                    links.optJSONArray("blockedIds")?.let { cur.put("blockedIds", it) }
                    Prefs.linkIdentity = cur
                }
                setState(Hub.status, Hub.code, Hub.user, links)
            }
            "unlinked" -> {
                Prefs.linkIdentity = null
                setState("connecting", null, null, null)
            }
            "drop" -> {
                Prefs.recordHistory(msg)
                Hub.changed()
                // Mode tranquille / heures calmes : noté mais pas affiché
                if (!Prefs.isMuted()) overlay.show(msg)
            }
            "ping" -> send(JSONObject().put("type", "pong"))
        }
    }

    private fun setState(status: String, code: String?, user: JSONObject?, links: JSONObject?) {
        Hub.status = status
        Hub.code = code
        Hub.user = user
        Hub.links = links
        updateNotification()
        Hub.changed()
    }

    // ── Actions appelées depuis l'interface ──────────────────────────────

    fun setMute(minutes: Int) {
        Prefs.muteUntil = when {
            minutes == 0 -> 0L
            minutes < 0 -> -1L
            else -> System.currentTimeMillis() + minutes * 60_000L
        }
        updateNotification()
        Hub.changed()
    }

    fun onSettingChanged() {
        overlay.pushSettings()
        updateNotification()
    }

    fun testDrop() {
        overlay.show(JSONObject()
            .put("type", "drop")
            .put("media", JSONObject().put("url", "about:blank").put("kind", "test")
                .put("mime", "test/test").put("name", "test.png").put("size", 0))
            .put("caption", "TEST DROP")
            .put("from", JSONObject().put("id", "0").put("username", "Toi (test)"))
            .put("ts", System.currentTimeMillis()))
    }

    fun replay(ts: Long): Boolean {
        val h = Prefs.findHistory(ts) ?: return false
        if (h.isNull("media") && h.isNull("rain") && h.isNull("tts")) return false
        val payload = JSONObject().put("ts", System.currentTimeMillis())
        for (k in listOf("media", "music", "rain", "tts", "ttsUrl", "effect", "caption")) {
            payload.put(k, if (h.isNull(k)) JSONObject.NULL else h.get(k))
        }
        payload.put("from", JSONObject()
            .put("username", h.optString("from"))
            .put("avatar", if (h.isNull("avatar")) JSONObject.NULL else h.optString("avatar")))
        overlay.show(payload)
        return true
    }

    // ── Notification ──────────────────────────────────────────────────────

    private fun createChannel() {
        val nm = getSystemService(NotificationManager::class.java)
        val ch = NotificationChannel(CHANNEL, "MemeDrop", NotificationManager.IMPORTANCE_LOW)
        ch.description = "Connexion au bot MemeDrop"
        ch.setShowBadge(false)
        nm.createNotificationChannel(ch)
    }

    private fun updateNotification() {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIF_ID, buildNotification())
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val muted = Prefs.isManuallyMuted()
        val base = when (Hub.status) {
            "linked" -> "Connecté · ${Hub.user?.optString("username") ?: ""}"
            "awaiting_link" -> "Tape /link ${Hub.code ?: ""} sur Discord"
            "connecting" -> "Connexion au bot…"
            "paused" -> "Connexion en pause"
            else -> "Hors ligne — reconnexion…"
        }
        val suffix = when {
            muted -> " · 🔇 tranquille"
            Prefs.quietHoursActive() -> " · 🌙 heures calmes"
            else -> ""
        }
        val muteAction = if (muted) action(ACTION_UNMUTE, "Réactiver") else action(ACTION_MUTE, "Tranquille 1 h")
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("MemeDrop")
            .setContentText(base + suffix)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .addAction(muteAction)
            .addAction(action(ACTION_STOP, "Quitter"))
            .build()
    }

    private fun action(act: String, label: String): Notification.Action {
        val pi = PendingIntent.getService(
            this, act.hashCode(), Intent(this, MemeDropService::class.java).setAction(act),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return Notification.Action.Builder(Icon.createWithResource(this, R.drawable.ic_stat), label, pi).build()
    }
}
