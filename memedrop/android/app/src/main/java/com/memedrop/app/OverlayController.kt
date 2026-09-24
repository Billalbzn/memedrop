package com.memedrop.app

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.hypot

// Fenêtre transparente plein écran, par-dessus les autres applis, qui charge
// overlay.html (le même renderer que sur Windows) et y pousse les drops.
//
// Cette grande fenêtre ne capte jamais le toucher (le jeu dessous doit rester
// jouable). Pour pouvoir déplacer / fermer un mème, on pose au-dessus de
// chaque drop une petite fenêtre tactile invisible, à sa taille exacte
// (positions envoyées par android-shim.js) : glisser déplace le mème,
// toucher la croix le ferme.
class OverlayController(private val ctx: Context) {
    private val wm = ctx.getSystemService(WindowManager::class.java)
    private var web: WebView? = null
    private var ready = false
    private val pending = mutableListOf<String>()

    // La fenêtre est retirée après un moment sans drop : inutile de garder une
    // WebView plein écran attachée en permanence.
    private val idleRemove = Runnable { destroy() }
    private val idleDelayMs = 90_000L

    // Zones tactiles posées sur les drops, par data-key de l'ancre
    private class Handle(
        val view: View,
        val lp: WindowManager.LayoutParams,
        var cx: Double,
        var cy: Double,
    ) {
        var dragging = false
        var downX = 0f
        var downY = 0f
        var startX = 0
        var startY = 0
        var startCx = 0.0
        var startCy = 0.0
    }
    private val handles = mutableMapOf<String, Handle>()
    private var dpr = 1.0
    private val touchSlop = ViewConfiguration.get(ctx).scaledTouchSlop
    private val density = ctx.resources.displayMetrics.density

    inner class OverlayBridge {
        @JavascriptInterface
        fun rects(json: String) {
            Hub.main.post { syncHandles(json) }
        }
    }

    fun canDraw(): Boolean = Settings.canDrawOverlays(ctx)

    fun show(payload: JSONObject) {
        if (!canDraw()) return
        val p = JSONObject(payload.toString()).put("settings", Prefs.dropSettings())
        run("window.__mdDrop($p)")
        Hub.main.removeCallbacks(idleRemove)
        Hub.main.postDelayed(idleRemove, idleDelayMs)
    }

    fun pushSettings() {
        val w = web ?: return
        if (ready) w.evaluateJavascript("window.__mdSettings(${Prefs.dropSettings()})", null)
    }

    private fun run(js: String) {
        val w = ensureView() ?: return
        if (ready) w.evaluateJavascript(js, null) else pending.add(js)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun ensureView(): WebView? {
        web?.let { return it }
        val w = WebView(ctx)
        w.setBackgroundColor(Color.TRANSPARENT)
        w.settings.javaScriptEnabled = true
        w.settings.domStorageEnabled = true
        w.settings.mediaPlaybackRequiresUserGesture = false
        w.addJavascriptInterface(OverlayBridge(), "MDOverlay")
        w.webViewClient = object : WebViewClient() {
            override fun onPageFinished(view: WebView, url: String) {
                ready = true
                view.evaluateJavascript("window.__mdSettings(${Prefs.dropSettings()})", null)
                for (js in pending) view.evaluateJavascript(js, null)
                pending.clear()
            }
        }

        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        )
        // Android 12+ bloque les touches qui traversent une fenêtre d'une autre
        // appli si son opacité dépasse 0.8 : sans ça, le jeu en dessous ne
        // réagirait plus du tout pendant l'affichage d'un drop.
        lp.alpha = 0.78f
        if (Build.VERSION.SDK_INT >= 28) {
            lp.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }

        return try {
            wm.addView(w, lp)
            w.loadUrl("file:///android_asset/overlay.html")
            web = w
            w
        } catch (e: Exception) {
            w.destroy()
            null
        }
    }

    // ── Zones tactiles ───────────────────────────────────────────────────

    private fun syncHandles(json: String) {
        if (web == null) return
        val obj = runCatching { JSONObject(json) }.getOrNull() ?: return
        dpr = obj.optDouble("dpr", 1.0).takeIf { it > 0 } ?: 1.0
        val arr = obj.optJSONArray("rects") ?: JSONArray()
        val seen = HashSet<String>()
        for (i in 0 until arr.length()) {
            val r = arr.optJSONObject(i) ?: continue
            val key = r.optString("key")
            if (key.isEmpty()) continue
            seen.add(key)
            val h = handles[key]
            if (h == null) {
                createHandle(key, r)
            } else if (!h.dragging) {
                h.cx = r.optDouble("cx")
                h.cy = r.optDouble("cy")
                h.lp.x = r.optInt("x")
                h.lp.y = r.optInt("y")
                h.lp.width = r.optInt("w")
                h.lp.height = r.optInt("h")
                runCatching { wm.updateViewLayout(h.view, h.lp) }
            }
        }
        for (k in handles.keys.filter { it !in seen }) removeHandle(k)
    }

    private fun createHandle(key: String, r: JSONObject) {
        val lp = WindowManager.LayoutParams(
            r.optInt("w"),
            r.optInt("h"),
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        )
        lp.gravity = Gravity.TOP or Gravity.START
        lp.x = r.optInt("x")
        lp.y = r.optInt("y")
        if (Build.VERSION.SDK_INT >= 28) {
            lp.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        }
        val v = View(ctx)
        val h = Handle(v, lp, r.optDouble("cx"), r.optDouble("cy"))
        v.setOnTouchListener { _, e -> onHandleTouch(key, h, e); true }
        try {
            wm.addView(v, lp)
            handles[key] = h
        } catch (_: Exception) {}
    }

    private fun removeHandle(key: String) {
        val h = handles.remove(key) ?: return
        try { wm.removeView(h.view) } catch (_: Exception) {}
    }

    private fun onHandleTouch(key: String, h: Handle, e: MotionEvent) {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                h.downX = e.rawX
                h.downY = e.rawY
                h.startX = h.lp.x
                h.startY = h.lp.y
                h.startCx = h.cx
                h.startCy = h.cy
                h.dragging = false
            }
            MotionEvent.ACTION_MOVE -> {
                val dx = e.rawX - h.downX
                val dy = e.rawY - h.downY
                if (!h.dragging && hypot(dx, dy) > touchSlop) h.dragging = true
                if (h.dragging) {
                    h.lp.x = h.startX + dx.toInt()
                    h.lp.y = h.startY + dy.toInt()
                    runCatching { wm.updateViewLayout(h.view, h.lp) }
                    h.cx = h.startCx + dx / dpr
                    h.cy = h.startCy + dy / dpr
                    web?.evaluateJavascript("window.__mdDropCtl && __mdDropCtl.move('$key', ${h.cx}, ${h.cy})", null)
                }
            }
            MotionEvent.ACTION_UP -> {
                // Simple toucher (pas de glissé) dans le coin haut-droit = la croix
                val zone = 64 * density
                if (!h.dragging && e.x >= h.lp.width - zone && e.y <= zone) {
                    web?.evaluateJavascript("window.__mdDropCtl && __mdDropCtl.close('$key')", null)
                    removeHandle(key)
                }
                h.dragging = false
            }
            MotionEvent.ACTION_CANCEL -> h.dragging = false
        }
    }

    fun destroy() {
        Hub.main.removeCallbacks(idleRemove)
        for (k in handles.keys.toList()) removeHandle(k)
        val w = web ?: return
        web = null
        ready = false
        pending.clear()
        try { wm.removeView(w) } catch (_: Exception) {}
        w.destroy()
    }
}
