package com.yuketangstudio.shell

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import java.util.concurrent.Executors

/**
 * 扫一扫：CameraX 预览 + ML Kit 条码识别。
 * 扫到第一个条码 → onScanned(String) 回调给 MainActivity 处理，然后 finish。
 * 结果经 resultReceiver 或静态字段回传（进程内最简单：静态回调）。
 */
class ScanActivity : AppCompatActivity() {

    private lateinit var previewView: PreviewView
    private val cameraExecutor = Executors.newSingleThreadExecutor()
    private var handled = false

    companion object {
        private const val TAG = "YktScan"
        private const val REQ_CAMERA = 42
        /** 进程内回调：MainActivity 扫码前设置，扫到后调用 */
        var onResult: ((String) -> Unit)? = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // 全屏黑底 + 顶部提示 + 取消按钮
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        previewView = PreviewView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
        root.addView(previewView)
        // 取景框提示
        val hint = TextView(this).apply {
            text = "对准二维码"
            setTextColor(Color.WHITE)
            textSize = 15f
            gravity = Gravity.CENTER
            setPadding(0, dp(28), 0, 0)
        }
        root.addView(hint)
        // 半透明遮罩 + 方形取景框
        val mask = View(this).apply {
            val s = dp(220)
            layoutParams = FrameLayout.LayoutParams(s, s, Gravity.CENTER)
            background = GradientDrawable().apply {
                setStroke(dp(2), Color.WHITE)
                cornerRadius = dp(8).toFloat()
            }
        }
        root.addView(mask)
        val cancel = TextView(this).apply {
            text = "✕  取消"
            setTextColor(Color.WHITE)
            textSize = 16f
            setPadding(dp(20), dp(12), dp(20), dp(12))
            layoutParams = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            ).apply { bottomMargin = dp(40) }
            setOnClickListener { finish() }
        }
        root.addView(cancel)
        setContentView(root)

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
            == PackageManager.PERMISSION_GRANTED) {
            startCamera()
        } else {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
        }
    }

    private fun dp(v: Int) = TypedValue.applyDimension(
        TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

    override fun onRequestPermissionsResult(
        requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == REQ_CAMERA) {
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) startCamera()
            else { toast("需要相机权限才能扫码"); finish() }
        }
    }

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            val provider = future.get()
            val preview = Preview.Builder().build().also {
                it.setSurfaceProvider(previewView.surfaceProvider)
            }
            val analysis = ImageAnalysis.Builder()
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .build()
            val scanner = BarcodeScanning.getClient()
            analysis.setAnalyzer(cameraExecutor) { imageProxy ->
                processFrame(scanner, imageProxy)
            }
            try {
                provider.unbindAll()
                provider.bindToLifecycle(this, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            } catch (e: Exception) {
                Log.e(TAG, "bind camera fail", e)
                toast("相机启动失败")
                finish()
            }
        }, ContextCompat.getMainExecutor(this))
    }

    @androidx.annotation.OptIn(androidx.camera.core.ExperimentalGetImage::class)
    private fun processFrame(scanner: com.google.mlkit.vision.barcode.BarcodeScanner, proxy: ImageProxy) {
        val media = proxy.image
        if (media == null) { proxy.close(); return }
        val img = InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees)
        scanner.process(img)
            .addOnSuccessListener { barcodes ->
                if (handled) return@addOnSuccessListener
                barcodes.firstOrNull { it.rawValue != null }?.let { b ->
                    handled = true
                    val raw = b.rawValue!!
                    Log.i(TAG, "扫描结果: $raw")
                    runOnUiThread {
                        toast("已识别")
                        onResult?.invoke(raw) ?: Log.w(TAG, "onResult=null raw=$raw")
                        finish()
                    }
                }
            }
            .addOnFailureListener { Log.w(TAG, "scan fail", it) }
            .addOnCompleteListener { proxy.close() }
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    override fun onDestroy() {
        cameraExecutor.shutdown()
        super.onDestroy()
    }
}
