import java.util.Properties
import java.io.FileInputStream

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 签名凭据：读 local.properties（不入库）
val localPropsFile = rootProject.file("local.properties")
val localProps = Properties().apply {
    if (localPropsFile.exists()) FileInputStream(localPropsFile).use { load(it) }
}

android {
    namespace = "com.yuketangstudio.shell"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.yuketangstudio.shell"
        minSdk = 26
        targetSdk = 34
        versionCode = 42
        versionName = "0.7.4"
        // 只留 ARM 真机：x86/x86_64/armeabi-v7a 的 barhopper_v3.so 各占 3-6MB，
        // 砍掉后 APK 减 ~12MB（模拟器不在目标场景内）
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a") }
    }

    // 签名：凭据存 local.properties（不入库），keystore 文件也不入库
    signingConfigs {
        create("release") {
            storeFile = file("release.keystore")
            storePassword = localProps.getProperty("ykt.storePassword") ?: ""
            keyAlias = localProps.getProperty("ykt.keyAlias") ?: "ykt"
            keyPassword = localProps.getProperty("ykt.keyPassword") ?: ""
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // Kotlin JVM target 与 Java 17 对齐（JDK26 默认 22 会不一致报错）
    kotlin {
        compilerOptions {
            jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
        }
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
    // 扫一扫：CameraX + ML Kit 条码识别（与官方 app 同款引擎）
    implementation("androidx.camera:camera-core:1.4.0")
    implementation("androidx.camera:camera-camera2:1.4.0")
    implementation("androidx.camera:camera-lifecycle:1.4.0")
    implementation("androidx.camera:camera-view:1.4.0")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
}
