package app.masalapos.printer

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.IOException
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.util.UUID

/**
 * Moves receipt bytes to a thermal printer: Bluetooth Classic serial (SPP) or a TCP socket (port 9100).
 * It knows nothing about bills. Each job connects, writes, flushes and closes.
 */
class MasalaposPrinterModule : Module() {
  /** A failure the app explains to the cashier; `code` is what printErrorMessage reads in TypeScript. */
  private class PrintFailure(code: String, message: String, cause: Throwable? = null) : CodedException(code, message, cause)

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("No Android context")

  private fun adapter(): BluetoothAdapter? =
    (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

  private fun hasConnectPermission(): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
      context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED

  private fun state(): String {
    val adapter = adapter() ?: return "unsupported"
    if (!hasConnectPermission()) return "no_permission"
    return if (adapter.isEnabled) "ready" else "off"
  }

  override fun definition() = ModuleDefinition {
    Name("MasalaposPrinter")

    AsyncFunction("bluetoothState") { state() }

    @SuppressLint("MissingPermission")
    AsyncFunction("pairedPrinters") {
      when (state()) {
        "ready" -> adapter()!!.bondedDevices
          .map { mapOf("name" to (it.name ?: it.address), "address" to it.address) }
          .sortedBy { it["name"]!!.lowercase() }
        "no_permission" -> throw PrintFailure("NO_PERMISSION", "Bluetooth permission is needed")
        "off" -> throw PrintFailure("BLUETOOTH_OFF", "Bluetooth is off")
        else -> emptyList()
      }
    }

    AsyncFunction("print") { transport: String, address: String, host: String, port: Int, base64: String, promise: Promise ->
      // Socket I/O blocks, so it runs on its own thread and never on the module's queue or the UI thread.
      Thread {
        try {
          val bytes = Base64.decode(base64, Base64.DEFAULT)
          if (transport == "network") printNetwork(host, port, bytes) else printBluetooth(address, bytes)
          promise.resolve(null)
        } catch (e: PrintFailure) {
          promise.reject(e)
        } catch (e: Exception) {
          promise.reject("WRITE_FAILED", e.message ?: "The printer stopped responding", e)
        }
      }.start()
    }
  }

  @SuppressLint("MissingPermission")
  private fun printBluetooth(address: String, bytes: ByteArray) {
    when (state()) {
      "unsupported" -> throw PrintFailure("PRINTER_UNREACHABLE", "This device has no Bluetooth")
      "no_permission" -> throw PrintFailure("NO_PERMISSION", "Bluetooth permission is needed")
      "off" -> throw PrintFailure("BLUETOOTH_OFF", "Bluetooth is off")
    }
    val adapter = adapter()!!
    // Discovery slows a connection down. Cancelling it needs BLUETOOTH_SCAN on Android 12+, which the app does not ask for.
    try { adapter.cancelDiscovery() } catch (_: SecurityException) {}
    val device = try { adapter.getRemoteDevice(address) } catch (e: IllegalArgumentException) {
      throw PrintFailure("PRINTER_UNREACHABLE", "The printer address is not valid", e)
    }
    var socket: BluetoothSocket? = null
    try {
      socket = connectWithOneRetry { device.createRfcommSocketToServiceRecord(SPP).also { it.connect() } }
      write(socket.outputStream, bytes)
      // Low-cost printers drop the end of a job if the socket closes straight after the last byte.
      Thread.sleep(300)
    } finally {
      try { socket?.close() } catch (_: IOException) {}
    }
  }

  private fun printNetwork(host: String, port: Int, bytes: ByteArray) {
    val socket = Socket()
    try {
      try { socket.connect(InetSocketAddress(host, port), 4_000) } catch (e: IOException) {
        throw PrintFailure("PRINTER_UNREACHABLE", "Could not reach $host:$port", e)
      }
      write(socket.getOutputStream(), bytes)
    } finally {
      try { socket.close() } catch (_: IOException) {}
    }
  }

  private fun connectWithOneRetry(connect: () -> BluetoothSocket): BluetoothSocket {
    return try { connect() } catch (first: IOException) {
      Thread.sleep(500)
      try { connect() } catch (second: IOException) {
        throw PrintFailure("PRINTER_UNREACHABLE", "Could not connect to the printer", second)
      }
    }
  }

  private fun write(out: OutputStream, bytes: ByteArray) {
    try {
      var at = 0
      while (at < bytes.size) {
        val n = minOf(CHUNK, bytes.size - at)
        out.write(bytes, at, n)
        at += n
      }
      out.flush()
    } catch (e: IOException) {
      throw PrintFailure("WRITE_FAILED", "The printer stopped responding", e)
    }
  }

  companion object {
    private val SPP: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
    private const val CHUNK = 4096
  }
}
