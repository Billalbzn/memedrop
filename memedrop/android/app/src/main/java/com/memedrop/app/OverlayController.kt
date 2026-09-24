package com.memedrop.app

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.graphics.PixelFormat
import android.os.Build
import android.provider.Settings
import android.view.WindowManager
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

// Fenêtre transparente plein écran, par-dessus les autres applis, qui charge
// overlay.html (le même renderer que sur Windows) et y pousse les drops.
class OverlayController(private val ctx: Context) {
    private val wm = ctx.getSystemService(WindowManager::class.java)
    private var web: WebView? = null
    private var ready = false
    private val pending = mutableListOf<String>()

    // La fenêtre est retirée après un moment sans drop : inutile de garder une
    // WebView plein écran attachée en permanence.
    private val idleRemove = Runnable { destroy() }
    private val idleDelayMs = 90_000L

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

    fun destroy() {
        Hub.main.removeCallbacks(idleRemove)
        val w = web ?: return
        web = null
        ready = false
        pending.clear()
        try { wm.removeView(w) } catch (_: Exception) {}
        w.destroy()
    }
}
