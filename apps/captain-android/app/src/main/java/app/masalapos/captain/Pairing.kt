package app.masalapos.captain

import java.net.URI
import java.net.URISyntaxException
import java.net.URLDecoder

/** A POS address to try and, for HTTPS from a pairing code, the restaurant CA fingerprint to pin. */
data class PairingRequest(val origin: String, val caFingerprint: String?) {
    val secure get() = origin.startsWith("https://")
}

class PairingException(message: String) : Exception(message)

object Pairing {
    const val CAPTAIN_HTTPS_PORT = 4443
    const val POS_HTTP_PORT = 4100

    /**
     * Reads a pairing code from POS Settings, an existing Captain link or a typed address.
     * Returns the connections to try, most secure first.
     */
    fun parse(input: String): List<PairingRequest> {
        val text = input.trim()
        if (text.isEmpty()) throw PairingException("Enter the POS address, for example 192.168.1.20")
        if (text.startsWith("masalapos-captain:", ignoreCase = true)) {
            val query = query(uri(text).rawQuery.orEmpty())
            val origin = origin(query["server"] ?: throw PairingException("This pairing code has no POS address"))
            val fingerprint = query["ca"]?.let(::fingerprint)
            if (origin.startsWith("https://") && fingerprint == null) throw PairingException("This pairing code is missing the restaurant certificate")
            return listOf(PairingRequest(origin, fingerprint))
        }
        if (text.contains("://")) return listOf(PairingRequest(origin(text), null))
        val address = uri("http://$text")
        val host = address.host ?: throw PairingException("Enter the POS address, for example 192.168.1.20")
        if (address.port != -1) return listOf(PairingRequest("https://$host:${address.port}", null), PairingRequest("http://$host:${address.port}", null))
        return listOf(PairingRequest("https://$host:$CAPTAIN_HTTPS_PORT", null), PairingRequest("http://$host:$POS_HTTP_PORT", null))
    }

    /** scheme://host[:port] only; Captain always opens /captain/ on that origin. */
    fun origin(url: String): String {
        val address = uri(url.trim())
        val scheme = address.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") throw PairingException("Use an http or https POS address")
        val host = address.host?.lowercase() ?: throw PairingException("The POS address has no host")
        return if (address.port == -1) "$scheme://$host" else "$scheme://$host:${address.port}"
    }

    /** SHA-256 as 64 uppercase hex digits, accepting the colon-separated form shown in POS Settings. */
    fun fingerprint(value: String): String {
        val hex = value.filterNot { it == ':' || it.isWhitespace() }.uppercase()
        if (hex.length != 64 || !hex.all { it in "0123456789ABCDEF" }) throw PairingException("The restaurant certificate fingerprint is not valid")
        return hex
    }

    fun displayFingerprint(hex: String) = hex.chunked(2).joinToString(":")

    private fun uri(text: String) = try { URI(text) } catch (_: URISyntaxException) { throw PairingException("That is not a valid POS address") }

    private fun query(raw: String) = raw.split('&').filter { it.isNotEmpty() }.associate { part ->
        val key = part.substringBefore('=')
        val value = part.substringAfter('=', "")
        URLDecoder.decode(key, "UTF-8") to URLDecoder.decode(value, "UTF-8")
    }
}
