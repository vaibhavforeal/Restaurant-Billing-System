package app.masalapos.captain

import java.io.ByteArrayInputStream
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory

/**
 * The restaurant's own certificate authority, created by tools/setup-captain-https.ps1.
 * The app trusts it directly, so tablets never install it into Android's certificate store.
 */
class RestaurantTrust(val authority: X509Certificate) {
    val fingerprint: String = sha256(authority.encoded)

    /** A server certificate is accepted only if this CA issued it for [host] and both are in date. */
    fun accepts(server: X509Certificate, host: String): Boolean = try {
        authority.checkValidity()
        server.checkValidity()
        server.verify(authority.publicKey)
        covers(server, host)
    } catch (_: GeneralSecurityException) {
        false
    } catch (_: IllegalArgumentException) {
        false
    }

    /** For the app's own requests (pairing check, updates): only this CA, with normal host name checks. */
    fun sslContext(): SSLContext {
        val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply {
            load(null, null)
            setCertificateEntry("restaurant", authority)
        }
        val trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(store) }
        return SSLContext.getInstance("TLS").apply { init(null, trust.trustManagers, null) }
    }

    companion object {
        /** Accepts the DER file written by Export-Certificate as well as PEM. */
        fun parse(bytes: ByteArray): RestaurantTrust = RestaurantTrust(certificate(bytes))

        fun certificate(bytes: ByteArray): X509Certificate = try {
            CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(bytes)) as X509Certificate
        } catch (_: GeneralSecurityException) {
            throw PairingException("The POS sent an unreadable certificate")
        }

        fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02X".format(it) }

        private const val DNS_NAME = 2
        private const val IP_ADDRESS = 7

        private fun covers(server: X509Certificate, host: String): Boolean =
            server.subjectAlternativeNames.orEmpty().any { name ->
                (name[0] == DNS_NAME || name[0] == IP_ADDRESS) && (name[1] as? String).equals(host, ignoreCase = true)
            }
    }
}
