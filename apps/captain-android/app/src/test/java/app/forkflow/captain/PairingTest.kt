package app.forkflow.captain

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class PairingTest {
    private val fingerprint = "F95325D841C7761CB8E8881F42D7B407BFE2B9139B1F11B6E5442011C1032253"

    @Test
    fun readsPairingCodesFromPosSettings() {
        val request = Pairing.parse("forkflow-captain://pair?server=https%3A%2F%2F192.168.1.50%3A4443&ca=$fingerprint").single()
        assertEquals("https://192.168.1.50:4443", request.origin)
        assertEquals(fingerprint, request.caFingerprint)
    }

    @Test
    fun acceptsUnencryptedPairingCodesWithoutACertificate() {
        val request = Pairing.parse("forkflow-captain://pair?server=http%3A%2F%2F192.168.1.50%3A4100").single()
        assertEquals("http://192.168.1.50:4100", request.origin)
        assertNull(request.caFingerprint)
    }

    @Test
    fun refusesHttpsPairingCodesWithoutAFingerprint() {
        assertThrows(PairingException::class.java) { Pairing.parse("forkflow-captain://pair?server=https%3A%2F%2F192.168.1.50%3A4443") }
        assertThrows(PairingException::class.java) { Pairing.parse("forkflow-captain://pair?server=https%3A%2F%2F192.168.1.50%3A4443&ca=ABCD") }
    }

    @Test
    fun triesTheCaptainHttpsPortBeforeTheDesktopPortForTypedAddresses() {
        assertEquals(
            listOf(PairingRequest("https://192.168.1.50:4443", null), PairingRequest("http://192.168.1.50:4100", null)),
            Pairing.parse(" 192.168.1.50 "),
        )
        assertEquals("https://192.168.1.50:9443", Pairing.parse("192.168.1.50:9443").first().origin)
    }

    @Test
    fun keepsOnlyTheOriginOfCaptainLinks() {
        assertEquals(listOf(PairingRequest("https://192.168.1.50:4443", null)), Pairing.parse("HTTPS://192.168.1.50:4443/captain/"))
        assertThrows(PairingException::class.java) { Pairing.parse("ftp://192.168.1.50") }
        assertThrows(PairingException::class.java) { Pairing.parse("") }
    }

    @Test
    fun acceptsTheColonFingerprintShownInSettings() {
        assertEquals(fingerprint, Pairing.fingerprint(Pairing.displayFingerprint(fingerprint).lowercase()))
    }
}
