package app.masalapos.captain

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONException
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * Installs the Captain app shipped with each MasalaPOS release, from the paired POS.
 * tools/build-desktop.mjs publishes version.json and the APK under /captain/android/.
 */
class AppUpdater(private val activity: Activity, private val server: PairedServer) {
    private data class Release(val versionCode: Int, val versionName: String, val sha256: String)

    private val worker = Executors.newSingleThreadExecutor()
    private var checkedAt = 0L
    private var busy = false

    fun checkSoon() {
        val now = SystemClock.elapsedRealtime()
        if (busy || (checkedAt != 0L && now - checkedAt < CHECK_INTERVAL_MS)) return
        checkedAt = now
        worker.execute {
            val release = latest() ?: return@execute
            if (release.versionCode > BuildConfig.VERSION_CODE) activity.runOnUiThread { offer(release) }
        }
    }

    fun close() = worker.shutdownNow()

    private fun latest(): Release? = try {
        val json = JSONObject(String(PosConnection.read(server, "/captain/android/version.json")))
        Release(json.getInt("versionCode"), json.getString("versionName"), json.getString("sha256").uppercase())
    } catch (_: IOException) {
        null
    } catch (_: JSONException) {
        null // Builds without the Android app answer with the POS page instead.
    }

    private fun offer(release: Release) {
        if (activity.isFinishing || busy) return
        AlertDialog.Builder(activity)
            .setTitle(activity.getString(R.string.update_title, release.versionName))
            .setMessage(R.string.update_message)
            .setPositiveButton(R.string.update_now) { _, _ -> download(release) }
            .setNegativeButton(R.string.later, null)
            .show()
    }

    private fun download(release: Release) {
        busy = true
        val progress = AlertDialog.Builder(activity).setMessage(R.string.update_downloading).setCancelable(false).show()
        worker.execute {
            val file = try { fetch(release) } catch (_: IOException) { null }
            activity.runOnUiThread {
                busy = false
                progress.dismiss()
                if (file == null) {
                    AlertDialog.Builder(activity).setMessage(R.string.update_failed).setPositiveButton(android.R.string.ok, null).show()
                } else install(file)
            }
        }
    }

    private fun fetch(release: Release): File {
        val folder = File(activity.cacheDir, "updates").apply { mkdirs() }
        val file = File(folder, "MasalaPOS-Captain.apk")
        val digest = MessageDigest.getInstance("SHA-256")
        val connection = PosConnection.open(server, "/captain/android/MasalaPOS-Captain.apk", timeoutMs = 60_000)
        try {
            if (connection.responseCode != 200) throw IOException("Update download failed")
            connection.inputStream.use { input ->
                file.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        digest.update(buffer, 0, read)
                        output.write(buffer, 0, read)
                    }
                }
            }
        } finally {
            connection.disconnect()
        }
        val actual = digest.digest().joinToString("") { "%02X".format(it) }
        if (actual != release.sha256) {
            file.delete()
            throw IOException("Update file was incomplete")
        }
        return file
    }

    private fun install(file: File) {
        if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
            checkedAt = 0L // Offer again when staff return from Settings.
            AlertDialog.Builder(activity)
                .setMessage(R.string.update_permission)
                .setPositiveButton(R.string.open_settings) { _, _ ->
                    activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
                }
                .setNegativeButton(R.string.later, null)
                .show()
            return
        }
        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.updates", file)
        activity.startActivity(Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION))
    }

    private companion object {
        const val CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000L
    }
}
