package com.memedrop.app

import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.util.concurrent.CopyOnWriteArraySet

// État de connexion partagé entre le service (qui le modifie) et l'activité
// (qui l'affiche). Tout tourne dans le même process.
object Hub {
    val main = Handler(Looper.getMainLooper())

    // connecting | awaiting_link | linked | disconnected | paused | stopped
    @Volatile var status: String = "stopped"
    @Volatile var code: String? = null
    @Volatile var user: JSONObject? = null
    @Volatile var links: JSONObject? = null
    @Volatile var service: MemeDropService? = null

    private val listeners = CopyOnWriteArraySet<Runnable>()

    fun addListener(l: Runnable) { listeners.add(l) }
    fun removeListener(l: Runnable) { listeners.remove(l) }

    fun changed() {
        main.post { for (l in listeners) l.run() }
    }
}
