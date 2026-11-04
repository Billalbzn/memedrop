package com.memedrop.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// Relance le service au démarrage du téléphone et après une mise à jour de
// l'appli (qui arrête le process), si "Lancer au démarrage" est actif.
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val a = intent.action
        if (a != Intent.ACTION_BOOT_COMPLETED && a != Intent.ACTION_MY_PACKAGE_REPLACED) return
        Prefs.init(ctx)
        if (!Prefs.settings().optBoolean("autostart", true)) return
        runCatching { ctx.startForegroundService(Intent(ctx, MemeDropService::class.java)) }
    }
}
