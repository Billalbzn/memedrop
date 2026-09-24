package com.memedrop.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// Relance le service au démarrage du téléphone si "Lancer au démarrage" est actif.
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        Prefs.init(ctx)
        if (!Prefs.settings().optBoolean("autostart", true)) return
        runCatching { ctx.startForegroundService(Intent(ctx, MemeDropService::class.java)) }
    }
}
