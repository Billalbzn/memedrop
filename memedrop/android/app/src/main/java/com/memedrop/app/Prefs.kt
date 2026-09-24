package com.memedrop.app

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar

// Réglages et état persistés — équivalent du electron-store de l'overlay
// Windows (mêmes clés, mêmes valeurs par défaut).
object Prefs {
    const val DEFAULT_SERVER = "wss://memedrop-bot.fly.dev"
    private const val MAX_HISTORY = 20

    private lateinit var sp: SharedPreferences

    fun init(ctx: Context) {
        if (!::sp.isInitialized) {
            sp = ctx.applicationContext.getSharedPreferences("memedrop", Context.MODE_PRIVATE)
        }
    }

    // Toute ancienne URL Railway (serveur coupé) bascule sur le serveur actuel.
    var serverUrl: String
        get() = sp.getString("serverUrl", null)
            ?.takeUnless { it.contains(".up.railway.app", ignoreCase = true) }
            ?: DEFAULT_SERVER
        set(v) { sp.edit().putString("serverUrl", v).apply() }

    // Pause manuelle : l'app ne se connecte pas au bot.
    var paused: Boolean
        get() = sp.getBoolean("paused", false)
        set(v) { sp.edit().putBoolean("paused", v).apply() }

    // Mode tranquille : 0 = inactif, -1 = jusqu'à réactivation, sinon timestamp.
    var muteUntil: Long
        get() = sp.getLong("muteUntil", 0L)
        set(v) { sp.edit().putLong("muteUntil", v).apply() }

    // Identité de lien rejouée à chaque connexion (ré-enregistrement auto).
    var linkIdentity: JSONObject?
        get() = sp.getString("linkIdentity", null)?.let { runCatching { JSONObject(it) }.getOrNull() }
        set(v) { sp.edit().putString("linkIdentity", v?.toString()).apply() }

    private fun defaults(): JSONObject = JSONObject()
        .put("volume", 0.75)
        .put("musicVolume", 0.75)
        .put("opacity", 1.0)
        .put("duration", 4)
        .put("videoDuration", 30)
        .put("soundOnArrival", true)
        .put("spotlightOnDrop", false)
        .put("theme", "classic")
        .put("avoidZone", "none")
        .put("autostart", true)
        .put("quietHours", JSONObject().put("enabled", false).put("start", "22:00").put("end", "08:00"))

    private fun savedSettings(): JSONObject =
        sp.getString("settings", null)?.let { runCatching { JSONObject(it) }.getOrNull() } ?: JSONObject()

    fun settings(): JSONObject {
        val out = defaults()
        val saved = savedSettings()
        for (k in saved.keys()) out.put(k, saved.get(k))
        return out
    }

    fun setSetting(key: String, value: Any?) {
        val saved = savedSettings()
        saved.put(key, value ?: JSONObject.NULL)
        sp.edit().putString("settings", saved.toString()).apply()
    }

    // Réglages joints à chaque drop envoyé au renderer de l'overlay.
    fun dropSettings(): JSONObject {
        val s = settings()
        val out = JSONObject()
        for (k in listOf("volume", "musicVolume", "opacity", "duration", "videoDuration",
                "soundOnArrival", "spotlightOnDrop", "avoidZone", "theme")) {
            out.put(k, s.opt(k))
        }
        return out
    }

    fun isManuallyMuted(): Boolean {
        val until = muteUntil
        if (until == 0L) return false
        if (until == -1L || until > System.currentTimeMillis()) return true
        muteUntil = 0L
        return false
    }

    // Heures calmes : vrai si l'heure locale est dans le créneau configuré
    // (gère les créneaux qui traversent minuit, ex. 22:00 → 08:00).
    fun quietHoursActive(): Boolean {
        val qh = settings().optJSONObject("quietHours") ?: return false
        if (!qh.optBoolean("enabled", false)) return false
        val start = toMinutes(qh.optString("start", "22:00")) ?: return false
        val end = toMinutes(qh.optString("end", "08:00")) ?: return false
        if (start == end) return false
        val c = Calendar.getInstance()
        val cur = c.get(Calendar.HOUR_OF_DAY) * 60 + c.get(Calendar.MINUTE)
        return if (start < end) cur in start until end else (cur >= start || cur < end)
    }

    private fun toMinutes(s: String): Int? {
        val m = Regex("^(\\d{1,2}):(\\d{2})$").find(s) ?: return null
        return m.groupValues[1].toInt() * 60 + m.groupValues[2].toInt()
    }

    fun isMuted(): Boolean = quietHoursActive() || isManuallyMuted()

    fun history(): JSONArray =
        sp.getString("history", null)?.let { runCatching { JSONArray(it) }.getOrNull() } ?: JSONArray()

    fun clearHistory() {
        sp.edit().putString("history", "[]").apply()
    }

    fun recordHistory(p: JSONObject) {
        val media = p.optJSONObject("media")
        val from = p.optJSONObject("from")
        val kind = when {
            media != null -> media.optString("kind", "unknown")
            !p.isNull("tts") -> "tts"
            !p.isNull("rain") -> "rain"
            else -> "unknown"
        }
        val entry = JSONObject()
            .put("from", from?.let { if (it.isNull("username")) null else it.optString("username") } ?: "inconnu")
            .put("avatar", from?.let { if (it.isNull("avatar")) null else it.optString("avatar") } ?: JSONObject.NULL)
            .put("kind", kind)
            .put("ts", p.optLong("ts", System.currentTimeMillis()))
        for (k in listOf("caption", "media", "music", "rain", "tts", "ttsUrl", "effect")) {
            entry.put(k, if (p.isNull(k)) JSONObject.NULL else p.get(k))
        }
        val old = history()
        val out = JSONArray().put(entry)
        for (i in 0 until minOf(old.length(), MAX_HISTORY - 1)) out.put(old.get(i))
        sp.edit().putString("history", out.toString()).apply()
    }

    fun findHistory(ts: Long): JSONObject? {
        val h = history()
        for (i in 0 until h.length()) {
            val e = h.optJSONObject(i) ?: continue
            if (e.optLong("ts") == ts) return e
        }
        return null
    }
}
