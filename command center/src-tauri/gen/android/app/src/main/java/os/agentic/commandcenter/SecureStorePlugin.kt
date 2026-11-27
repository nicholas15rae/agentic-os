package os.agentic.commandcenter

import android.app.Activity
import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Phone-only secret store (the gateway token, so it survives app restarts).
 *
 * Values are encrypted with an AES-256-GCM key that lives in the Android Keystore (never
 * exportable, never in app storage); only the ciphertext + IV sit in this app's private
 * SharedPreferences. Rust reaches it through `register_android_plugin` (src/commands/phone_secrets.rs).
 */
@InvokeArg
class SecretArgs {
    lateinit var key: String
    var value: String? = null
}

@TauriPlugin
class SecureStorePlugin(private val activity: Activity) : Plugin(activity) {
    private val prefs by lazy { activity.getSharedPreferences("secure-store", Context.MODE_PRIVATE) }

    private fun secretKey(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    private fun validKey(k: String) = KEY_RE.matches(k)

    @Command
    fun get(invoke: Invoke) {
        val args = invoke.parseArgs(SecretArgs::class.java)
        if (!validKey(args.key)) return invoke.reject("bad key")
        val ret = JSObject()
        val stored = prefs.getString(args.key, null)
        if (stored == null) {
            ret.put("value", "")
            return invoke.resolve(ret)
        }
        try {
            val (iv, ct) = stored.split(":", limit = 2).map { Base64.decode(it, Base64.NO_WRAP) }
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, iv))
            ret.put("value", String(cipher.doFinal(ct), Charsets.UTF_8))
        } catch (e: Exception) {
            // Key invalidated (e.g. a reset lock screen) or a damaged entry: forget it, ask again.
            prefs.edit().remove(args.key).apply()
            ret.put("value", "")
        }
        invoke.resolve(ret)
    }

    @Command
    fun set(invoke: Invoke) {
        val args = invoke.parseArgs(SecretArgs::class.java)
        if (!validKey(args.key)) return invoke.reject("bad key")
        val value = args.value ?: ""
        if (value.isEmpty()) {
            prefs.edit().remove(args.key).apply()
            return invoke.resolve()
        }
        if (value.length > 4096) return invoke.reject("value too long")
        try {
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.ENCRYPT_MODE, secretKey())
            val ct = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            val enc = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP)
            prefs.edit().putString(args.key, enc).apply()
            invoke.resolve()
        } catch (e: Exception) {
            invoke.reject("could not encrypt: ${e.javaClass.simpleName}")
        }
    }

    companion object {
        private const val KEYSTORE = "AndroidKeyStore"
        private const val ALIAS = "command-center-secure-store"
        private const val TRANSFORM = "AES/GCM/NoPadding"
        private val KEY_RE = Regex("^[a-z0-9-]{1,40}$")
    }
}
