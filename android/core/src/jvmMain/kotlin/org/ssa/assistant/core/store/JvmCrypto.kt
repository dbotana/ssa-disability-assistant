package org.ssa.assistant.core.store

import java.security.GeneralSecurityException
import java.security.SecureRandom
import java.text.Normalizer
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

/**
 * [Crypto] on the JVM and on Android, with javax.crypto only: PBKDF2WithHmacSHA256
 * and AES/GCM/NoPadding, both in every JDK and in Android since API 26. The
 * result is byte-for-byte WebCrypto's: the `store` golden's test vector,
 * encrypted with crypto.subtle in Node, decrypts here.
 */
class JvmCrypto(private val random: SecureRandom = SecureRandom()) : Crypto {

    private class Key(val spec: SecretKeySpec) : SessionKey

    override fun randomBytes(size: Int): ByteArray = ByteArray(size).also { random.nextBytes(it) }

    override fun deriveKey(pin: String, salt: ByteArray, iterations: Int): SessionKey {
        // WebCrypto derives from the UTF-8 bytes of String(pin).normalize('NFC').
        // PBEKeySpec takes chars and the JDK's PBKDF2 encodes them as UTF-8.
        val chars = Normalizer.normalize(pin, Normalizer.Form.NFC).toCharArray()
        val spec = PBEKeySpec(chars, salt, iterations, 256)
        try {
            val bytes = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded
            return Key(SecretKeySpec(bytes, "AES")).also { bytes.fill(0) }
        } finally {
            spec.clearPassword()
            chars.fill('\u0000')
        }
    }

    override fun encrypt(key: SessionKey, iv: ByteArray, plaintext: ByteArray): ByteArray =
        cipher(Cipher.ENCRYPT_MODE, key, iv).doFinal(plaintext)

    override fun decrypt(key: SessionKey, iv: ByteArray, ciphertext: ByteArray): ByteArray = try {
        cipher(Cipher.DECRYPT_MODE, key, iv).doFinal(ciphertext)
    } catch (e: AEADBadTagException) {
        throw DecryptFailed(e)
    } catch (e: GeneralSecurityException) {
        throw DecryptFailed(e)
    }

    private fun cipher(mode: Int, key: SessionKey, iv: ByteArray): Cipher =
        Cipher.getInstance("AES/GCM/NoPadding").apply {
            init(mode, (key as Key).spec, GCMParameterSpec(128, iv))
        }
}
