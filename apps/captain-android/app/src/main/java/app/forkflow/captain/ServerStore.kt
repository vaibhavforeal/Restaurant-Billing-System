package app.forkflow.captain

import android.content.Context
import android.util.Base64

/** The paired POS. Only the public CA certificate is stored, never a key or PIN. */
data class PairedServer(val origin: String, val trust: RestaurantTrust?) {
    val captainUrl get() = "$origin/captain/"
    val host: String get() = java.net.URI(origin).host
}

class ServerStore(context: Context) {
    private val prefs = context.getSharedPreferences("server", Context.MODE_PRIVATE)

    fun load(): PairedServer? {
        val origin = prefs.getString(ORIGIN, null) ?: return null
        val authority = prefs.getString(AUTHORITY, null)?.let { RestaurantTrust.parse(Base64.decode(it, Base64.NO_WRAP)) }
        return PairedServer(origin, authority)
    }

    fun save(server: PairedServer) {
        prefs.edit()
            .putString(ORIGIN, server.origin)
            .putString(AUTHORITY, server.trust?.let { Base64.encodeToString(it.authority.encoded, Base64.NO_WRAP) })
            .apply()
    }

    private companion object {
        const val ORIGIN = "origin"
        const val AUTHORITY = "authority"
    }
}
