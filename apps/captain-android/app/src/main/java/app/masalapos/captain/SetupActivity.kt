package app.masalapos.captain

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import com.google.zxing.integration.android.IntentIntegrator
import java.io.IOException
import java.util.concurrent.Executors

/**
 * Pairs the tablet with a POS by scanning the code in POS Settings or typing its address.
 * IntentIntegrator is deprecated only in favour of AndroidX result APIs, which this plain Activity avoids.
 */
@Suppress("DEPRECATION")
class SetupActivity : Activity() {
    private val worker = Executors.newSingleThreadExecutor()
    private lateinit var address: EditText
    private lateinit var status: TextView
    private lateinit var scan: Button
    private lateinit var connect: Button

    private sealed interface Outcome {
        data class Ready(val server: PairedServer) : Outcome
        data class CheckCertificate(val server: PairedServer) : Outcome
        data class Unencrypted(val server: PairedServer) : Outcome
        data class Failed(val message: String) : Outcome
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)
        address = findViewById(R.id.address)
        status = findViewById(R.id.status)
        scan = findViewById(R.id.scan)
        connect = findViewById(R.id.connect)
        scan.setOnClickListener { startScan() }
        connect.setOnClickListener { connect(address.text.toString()) }
        address.setOnEditorActionListener { _, action, _ ->
            (action == EditorInfo.IME_ACTION_GO).also { if (it) connect(address.text.toString()) }
        }
        val current = ServerStore(this).load()
        findViewById<Button>(R.id.cancel).apply {
            visibility = if (current != null) View.VISIBLE else View.GONE
            setOnClickListener { finish() }
        }
        if (current != null) findViewById<TextView>(R.id.current).apply {
            text = getString(R.string.setup_current, current.origin)
            visibility = View.VISIBLE
        }
        if (savedInstanceState == null) openPairingLink(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        openPairingLink(intent)
    }

    override fun onDestroy() {
        worker.shutdownNow()
        super.onDestroy()
    }

    /** A pairing code scanned with the system camera opens here; never re-pair without asking. */
    private fun openPairingLink(intent: Intent?) {
        val link = intent?.data?.takeIf { it.scheme == "masalapos-captain" }?.toString() ?: return
        val server = try { Pairing.parse(link).first().origin } catch (e: PairingException) { return showStatus(e.message) }
        AlertDialog.Builder(this)
            .setTitle(R.string.pair_link_title)
            .setMessage(getString(R.string.pair_link_message, server))
            .setPositiveButton(R.string.connect) { _, _ -> connect(link) }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun startScan() {
        IntentIntegrator(this)
            .setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
            .setPrompt(getString(R.string.scan_prompt))
            .setBeepEnabled(false)
            .setOrientationLocked(false)
            .initiateScan()
    }

    @Deprecated("IntentIntegrator reports through onActivityResult")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        val result = IntentIntegrator.parseActivityResult(requestCode, resultCode, data)
        if (result == null) return super.onActivityResult(requestCode, resultCode, data)
        result.contents?.let(::connect)
    }

    private fun connect(input: String) {
        val candidates = try { Pairing.parse(input) } catch (e: PairingException) { return showStatus(e.message) }
        setBusy(true)
        showStatus(getString(R.string.connecting))
        worker.execute {
            val outcome = try { reach(candidates) } catch (e: PairingException) { Outcome.Failed(e.message.orEmpty()) }
            runOnUiThread { if (!isFinishing) { setBusy(false); finish(outcome) } }
        }
    }

    private fun reach(candidates: List<PairingRequest>): Outcome {
        for (candidate in candidates) {
            if (!candidate.secure) {
                val server = PairedServer(candidate.origin, null)
                if (PosConnection.isPos(server)) return Outcome.Unencrypted(server)
                continue
            }
            val trust = try { PosConnection.downloadAuthority(candidate.origin) } catch (_: IOException) { continue }
            val server = PairedServer(candidate.origin, trust)
            if (candidate.caFingerprint != null && candidate.caFingerprint != trust.fingerprint) {
                return Outcome.Failed(getString(R.string.certificate_mismatch))
            }
            if (!PosConnection.isPos(server)) return Outcome.Failed(getString(R.string.certificate_rejected, server.host))
            return if (candidate.caFingerprint != null) Outcome.Ready(server) else Outcome.CheckCertificate(server)
        }
        return Outcome.Failed(getString(R.string.unreachable, candidates.first().origin))
    }

    private fun finish(outcome: Outcome) {
        when (outcome) {
            is Outcome.Ready -> pair(outcome.server)
            is Outcome.Failed -> showStatus(outcome.message)
            // Typed addresses carry no fingerprint, so staff compare it with POS Settings.
            is Outcome.CheckCertificate -> AlertDialog.Builder(this)
                .setTitle(R.string.check_certificate_title)
                .setMessage(getString(R.string.check_certificate_message, Pairing.displayFingerprint(outcome.server.trust!!.fingerprint)))
                .setPositiveButton(R.string.fingerprint_matches) { _, _ -> pair(outcome.server) }
                .setNegativeButton(android.R.string.cancel) { _, _ -> showStatus("") }
                .show()
            is Outcome.Unencrypted -> AlertDialog.Builder(this)
                .setTitle(R.string.unencrypted_title)
                .setMessage(getString(R.string.unencrypted_message, outcome.server.origin))
                .setPositiveButton(R.string.connect_anyway) { _, _ -> pair(outcome.server) }
                .setNegativeButton(android.R.string.cancel) { _, _ -> showStatus("") }
                .show()
        }
    }

    private fun pair(server: PairedServer) {
        ServerStore(this).save(server)
        startActivity(Intent(this, CaptainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
        finish()
    }

    private fun setBusy(busy: Boolean) {
        scan.isEnabled = !busy
        connect.isEnabled = !busy
        address.isEnabled = !busy
    }

    private fun showStatus(message: String?) {
        status.text = message
    }
}
