package app.masalapos.captain

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.cert.X509Certificate
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

/** Blocking requests to the POS; call off the main thread. */
object PosConnection {
    private const val TIMEOUT_MS = 6_000

    fun open(server: PairedServer, path: String, timeoutMs: Int = TIMEOUT_MS): HttpURLConnection {
        val connection = URL(server.origin + path).openConnection() as HttpURLConnection
        if (connection is HttpsURLConnection) {
            val trust = server.trust ?: throw IOException("No restaurant certificate for ${server.origin}")
            connection.sslSocketFactory = trust.sslContext().socketFactory
        }
        connection.connectTimeout = TIMEOUT_MS
        connection.readTimeout = timeoutMs
        connection.useCaches = false
        return connection
    }

    fun read(server: PairedServer, path: String): ByteArray {
        val connection = open(server, path)
        try {
            if (connection.responseCode != 200) throw IOException("POS answered ${connection.responseCode} for $path")
            return connection.inputStream.use { it.readBytes() }
        } finally {
            connection.disconnect()
        }
    }

    /** True when a MasalaPOS answers on this origin with the expected certificate. */
    fun isPos(server: PairedServer): Boolean = try {
        String(read(server, "/api/health")).contains("\"ok\":true")
    } catch (_: IOException) {
        false
    }

    /**
     * Downloads the public CA before it can be trusted. The result is only used after its
     * fingerprint matches the pairing code or staff compare it with POS Settings.
     */
    fun downloadAuthority(origin: String): RestaurantTrust {
        val connection = URL("$origin/captain/restaurant-ca.cer").openConnection() as HttpsURLConnection
        connection.sslSocketFactory = SSLContext.getInstance("TLS").apply { init(null, arrayOf(UnverifiedOnce), null) }.socketFactory
        connection.hostnameVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
        connection.connectTimeout = TIMEOUT_MS
        connection.readTimeout = TIMEOUT_MS
        try {
            if (connection.responseCode != 200) throw IOException("Captain HTTPS is not set up on this POS")
            return RestaurantTrust.parse(connection.inputStream.use { it.readBytes() })
        } finally {
            connection.disconnect()
        }
    }

    @Suppress("CustomX509TrustManager", "TrustAllX509TrustManager")
    private object UnverifiedOnce : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) = Unit
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }
}
