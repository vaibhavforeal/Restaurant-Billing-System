package app.forkflow.captain

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslCertificate
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.TextView
import android.window.OnBackInvokedDispatcher
import java.security.cert.X509Certificate

/** Hosts the POS's own Captain screens, so tablets always match the POS release. */
class CaptainActivity : Activity() {
    private lateinit var server: PairedServer
    private lateinit var web: WebView
    private lateinit var problem: View
    private lateinit var problemMessage: TextView
    private lateinit var updater: AppUpdater
    private var loadFailed = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val paired = ServerStore(this).load()
        if (paired == null) {
            openSetup()
            finish()
            return
        }
        server = paired
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_captain)
        fitSystemBars(findViewById(R.id.root))
        web = findViewById(R.id.web)
        problem = findViewById(R.id.problem)
        problemMessage = findViewById(R.id.problem_message)
        findViewById<Button>(R.id.retry).setOnClickListener { load() }
        findViewById<Button>(R.id.change_server).setOnClickListener { openSetup() }
        configure(web)
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { goBack() }
        }
        updater = AppUpdater(this, server)
        load()
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
        updater.checkSoon()
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onDestroy() {
        if (::web.isInitialized) web.destroy()
        if (::updater.isInitialized) updater.close()
        super.onDestroy()
    }

    @Deprecated("Android 13+ uses the OnBackInvokedCallback registered in onCreate")
    @Suppress("OVERRIDE_DEPRECATION")
    override fun onBackPressed() = goBack()

    /** Closes the top dialog or leaves the order first; only then moves the app to the background. */
    private fun goBack() {
        if (problem.visibility == View.VISIBLE) {
            moveTaskToBack(true)
            return
        }
        web.evaluateJavascript("window.forkflowBack ? window.forkflowBack() : false") { handled ->
            if (handled != "true") moveTaskToBack(true)
        }
    }

    private fun load() {
        problem.visibility = View.GONE
        web.visibility = View.VISIBLE
        web.loadUrl(server.captainUrl)
    }

    private fun showProblem(message: String) {
        problemMessage.text = message
        problem.visibility = View.VISIBLE
        web.visibility = View.INVISIBLE
    }

    private fun openSetup() {
        startActivity(Intent(this, SetupActivity::class.java))
    }

    @SuppressLint("SetJavaScriptEnabled", "JavascriptInterface")
    private fun configure(web: WebView) {
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            textZoom = 100
            setSupportZoom(false)
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            userAgentString = "$userAgentString ForkFlowCaptainAndroid/${BuildConfig.VERSION_NAME}"
        }
        web.addJavascriptInterface(Bridge(), "ForkFlowAndroid")
        // Shows the confirm() prompts the POS uses before discarding unsent items.
        web.webChromeClient = WebChromeClient()
        web.webViewClient = Client()
    }

    private fun isPos(url: Uri) = "${url.scheme}://${url.authority}".lowercase() == server.origin

    /** Read by apps/ui/src/captain-pwa.ts. */
    private inner class Bridge {
        @JavascriptInterface fun version(): String = BuildConfig.VERSION_NAME
        @JavascriptInterface fun server(): String = server.origin
        @JavascriptInterface fun changeServer() = runOnUiThread { openSetup() }
    }

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (isPos(request.url)) return false
            try { startActivity(Intent(Intent.ACTION_VIEW, request.url)) } catch (_: ActivityNotFoundException) { }
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            loadFailed = false
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (!loadFailed) problem.visibility = View.GONE
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            loadFailed = true
            showProblem(getString(R.string.reconnect_message))
        }

        /** The POS certificate is issued by the restaurant CA pinned at pairing, not a public CA. */
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            val certificate = error.certificate?.let(::x509)
            val trust = server.trust
            val forPos = isPos(Uri.parse(error.url))
            if (forPos && trust != null && certificate != null && trust.accepts(certificate, server.host)) return handler.proceed()
            handler.cancel()
            if (forPos) {
                loadFailed = true
                showProblem(getString(R.string.certificate_problem))
            }
        }
    }

    private fun x509(certificate: SslCertificate): X509Certificate? {
        if (Build.VERSION.SDK_INT >= 29) return certificate.x509Certificate
        // Before Android 10 the DER bytes are only reachable through the saved state bundle.
        val der = SslCertificate.saveState(certificate).getByteArray("x509-certificate") ?: return null
        return try { RestaurantTrust.certificate(der) } catch (_: PairingException) { null }
    }

    /** Android 15+ draws edge to edge; keep Captain's header and send bar clear of the bars and keyboard. */
    private fun fitSystemBars(root: View) {
        if (Build.VERSION.SDK_INT < 30) return
        @Suppress("DEPRECATION") // Android 15+ already enforces this.
        if (Build.VERSION.SDK_INT < 35) window.setDecorFitsSystemWindows(false)
        root.setOnApplyWindowInsetsListener { view, insets ->
            val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsets.CONSUMED
        }
    }
}
