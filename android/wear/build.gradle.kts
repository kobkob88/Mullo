import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
}

// Play upload key (S17), kept off the repo: ~/.mullo/upload.properties with storeFile,
// storePassword, keyAlias, keyPassword. Without it, release builds come out unsigned.
val upload = Properties().apply {
    val f = file("${System.getProperty("user.home")}/.mullo/upload.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "app.mullo.wear"
    compileSdk = 36
    defaultConfig {
        applicationId = "app.mullo"
        minSdk = 30
        targetSdk = 36
        versionCode = 13 // raise for every upload; Play wants phone and watch codes apart (phone even, watch odd)
        versionName = "0.1"
    }
    signingConfigs {
        if (upload.isNotEmpty()) create("release") {
            storeFile = file(upload.getProperty("storeFile"))
            storePassword = upload.getProperty("storePassword")
            keyAlias = upload.getProperty("keyAlias")
            keyPassword = upload.getProperty("keyPassword")
        }
    }
    buildTypes {
        release { signingConfigs.findByName("release")?.let { signingConfig = it } }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.play.services.wearable)
    // The Mullo record button on any watch face (RecordComplicationService).
    implementation(libs.wear.complications.data.source)
}
