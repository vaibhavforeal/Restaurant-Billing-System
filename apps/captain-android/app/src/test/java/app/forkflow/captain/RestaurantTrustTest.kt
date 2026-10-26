package app.forkflow.captain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** Fixtures were made with openssl: a restaurant CA, its server certificate for 192.168.1.50, and an unrelated CA. */
class RestaurantTrustTest {
    private fun resource(name: String) = javaClass.classLoader!!.getResourceAsStream(name)!!.use { it.readBytes() }
    private val restaurant = RestaurantTrust.parse(resource("restaurant-ca.cer"))
    private val server = RestaurantTrust.certificate(resource("server.pem"))

    @Test
    fun fingerprintMatchesTheOneShownInPosSettings() {
        assertEquals("F95325D841C7761CB8E8881F42D7B407BFE2B9139B1F11B6E5442011C1032253", restaurant.fingerprint)
    }

    @Test
    fun acceptsTheServerCertificateOnlyForItsOwnAddress() {
        assertTrue(restaurant.accepts(server, "192.168.1.50"))
        assertFalse(restaurant.accepts(server, "192.168.1.51"))
    }

    @Test
    fun rejectsServersIssuedByAnotherAuthority() {
        val stranger = RestaurantTrust.parse(resource("other-ca.cer"))
        assertFalse(stranger.accepts(server, "192.168.1.50"))
    }

    @Test
    fun rejectsUnreadableCertificates() {
        assertThrows(PairingException::class.java) { RestaurantTrust.parse("<html>".toByteArray()) }
    }
}
